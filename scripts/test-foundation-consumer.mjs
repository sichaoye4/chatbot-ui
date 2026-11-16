import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from '@playwright/test';

const root = resolve('.');
const name = `consumer-${Date.now()}`;
execFileSync(process.execPath, ['scripts/package-foundation-v2.mjs', name], {
  cwd: root,
  stdio: 'inherit',
});

const packageDir = resolve(root, 'artifacts/foundation-sdk', name);
const artifactsHost = resolve(root, 'artifacts/foundation-consumer', name);
mkdirSync(artifactsHost, { recursive: true });

// Pack a real release tarball containing only package.json + compiled dist/.
const tarballName = execFileSync('npm', ['pack', '--silent', '--pack-destination', artifactsHost], {
  cwd: packageDir,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
  .trim()
  .split(/\r?\n/)
  .pop();
assert.ok(tarballName?.endsWith('.tgz'), `Unexpected pack output: ${tarballName}`);
const tarballPath = join(artifactsHost, tarballName);

// Install into a completely separate temp directory outside the monorepo.
const externalHost = mkdtempSync(join(tmpdir(), 'foundation-v2-consumer-'));
let serverProcess;
const browser = await chromium.launch({ headless: true });

try {
  mkdirSync(join(externalHost, 'node_modules', '@source', 'chat-foundation-v2'), {
    recursive: true,
  });
  mkdirSync(join(externalHost, 'node_modules', '@types'), { recursive: true });
  writeFileSync(
    join(externalHost, 'package.json'),
    JSON.stringify(
      { name: 'external-foundation-consumer', private: true, type: 'module' },
      null,
      2,
    ) + '\n',
  );
  cpSync(resolve(root, 'tests/consumer/foundation-v2'), externalHost, { recursive: true });
  renameSync(join(externalHost, 'server-check.txt'), join(externalHost, 'server-check.ts'));

  // Extract compiled tarball contents into node_modules/@source/chat-foundation-v2.
  execFileSync(
    'tar',
    [
      '-xzf',
      tarballPath,
      '--strip-components=1',
      '-C',
      join(externalHost, 'node_modules/@source/chat-foundation-v2'),
    ],
    { stdio: 'inherit' },
  );
  assert.equal(
    existsSync(join(externalHost, 'node_modules/@source/chat-foundation-v2/src')),
    false,
    'Packed consumer package must ship compiled dist/ without raw src/',
  );
  assert.equal(
    existsSync(
      join(externalHost, 'node_modules/@source/chat-foundation-v2/dist/foundation-sdk/server.js'),
    ),
    true,
  );

  // Provide peer dependencies in the external temp directory.
  const depLinks = [
    ['react', join(root, 'node_modules/react')],
    ['react-dom', join(root, 'node_modules/react-dom')],
    ['zod', join(root, 'node_modules/zod')],
    ['@types/react', join(root, 'node_modules/@types/react')],
    ['@types/react-dom', join(root, 'node_modules/@types/react-dom')],
    ['@types/node', join(root, 'node_modules/@types/node')],
  ];
  for (const [targetName, sourcePath] of depLinks) {
    symlinkSync(sourcePath, join(externalHost, 'node_modules', targetName), 'junction');
  }

  // 1. Strict TypeScript check against compiled .d.ts files (no --allowImportingTsExtensions) and emit pure JS.
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--ignoreConfig',
      '--outDir',
      join(externalHost, 'dist-check'),
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--jsx',
      'react-jsx',
      '--strict',
      '--skipLibCheck',
      '--types',
      'node',
      join(externalHost, 'server-check.ts'),
    ],
    { cwd: externalHost, stdio: 'inherit' },
  );

  // 2. Run compiled JS check in plain Node ESM without tsx.
  execFileSync(process.execPath, [join(externalHost, 'dist-check/server-check.js')], {
    cwd: externalHost,
    stdio: 'inherit',
  });

  // 3. Build Vite client bundle against the external compiled package and verify zero server/secret leaks.
  execFileSync(
    process.execPath,
    [
      resolve(root, 'node_modules/vite/bin/vite.js'),
      'build',
      externalHost,
      '--outDir',
      join(externalHost, 'build'),
    ],
    { cwd: externalHost, stdio: 'inherit' },
  );
  const buildAssets = join(externalHost, 'build/assets');
  for (const file of readdirSync(buildAssets).filter((entry) => entry.endsWith('.js'))) {
    const source = readFileSync(join(buildAssets, file), 'utf8');
    assert.doesNotMatch(source, /node:sqlite|node:crypto|DEEPSEEK_API_KEY|FoundationBackend/);
  }

  // 4. Start the independent pure-Node ESM HTTP backend (no tsx) using FoundationBackend + SQLite + Bearer auth.
  serverProcess = spawn(process.execPath, [join(externalHost, 'host-server.mjs'), externalHost], {
    cwd: externalHost,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  const port = await new Promise((resolveReady, rejectReady) => {
    let stdout = '';
    const timer = setTimeout(
      () => rejectReady(new Error(`Server start timeout:\n${serverStderr}`)),
      15_000,
    );
    serverProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/CONSUMER_HOST_READY (\{[^\r\n]+\})/);
      if (match) {
        clearTimeout(timer);
        resolveReady(JSON.parse(match[1]).port);
      }
    });
    serverProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      serverStderr += text;
      process.stderr.write(text);
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Consumer server exited early (${code}):\n${serverStderr}`));
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Connecting to consumer server at ${baseUrl}`);

  // Verify host authentication blocks unauthenticated API access with 401.
  const unauthRes = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(unauthRes.status, 401);

  // 5. Run end-to-end Playwright journeys + Axe audit + wire check + reload persistence + embedded mode.
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[browser console error]', msg.text());
  });
  page.on('response', (res) => {
    if (res.status() >= 400) console.error('[browser http error]', res.status(), res.url());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(`${baseUrl}/`)) externalRequests.push(request.url());
  });

  await page.goto(`${baseUrl}/`);
  const composer = page.getByLabel('Message');
  await composer.fill('Show library inventory');
  await page.getByRole('button', { name: 'Send' }).click();
  try {
    await page.getByLabel('Host reading').getByText('42 books').waitFor({ timeout: 8000 });
  } catch (err) {
    console.error('[DOM snapshot]', await page.locator('body').innerText());
    console.error('[server stderr]', serverStderr);
    throw err;
  }
  await page.getByRole('cell', { name: 'Scanner Cradle' }).waitFor();

  // Paginate (ui.paginate@1), sort (ui.sort@1), and refresh (ui.refresh@1) over real HTTP backend.
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('cell', { name: 'Dock Seal' }).waitFor();
  await page.getByRole('button', { name: 'Item' }).click();
  await page.getByRole('cell', { name: 'Dock Seal' }).waitFor();
  await page.getByRole('cell', { name: 'Forklift Battery' }).waitFor();
  const warehouseSection = page.locator('section[aria-label="Warehouse inventory"]');
  await warehouseSection.getByRole('button', { name: 'Refresh data' }).click();
  await page.getByText(/Refreshed #\d+/).waitFor();

  // Second turn in another host domain.
  await composer.fill('Show energy capacity');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByLabel('Host reading').getByText('17 MW').waitFor();

  const chatAxe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  assert.deepEqual(chatAxe.violations, []);

  // Reload to verify persisted SQLite state is restored from GET /api/conversations/:id.
  await page.reload();
  await page.getByLabel('Host reading').getByText('42 books').waitFor();
  await page.getByLabel('Host reading').getByText('17 MW').waitFor();
  await page.getByRole('cell', { name: 'Forklift Battery' }).waitFor();

  // Fetch canonical conversation snapshot from HTTP backend and validate with independent Python reader.
  const convRes = await fetch(`${baseUrl}/api/conversations/hostconversation`, {
    headers: { Authorization: 'Bearer host-dev-secret' },
  });
  assert.equal(convRes.status, 200);
  const wirePath = join(artifactsHost, 'wire-snapshot.json');
  writeFileSync(wirePath, JSON.stringify(await convRes.json(), null, 2));
  execFileSync('python', [join(externalHost, 'wire_check.py'), wirePath], {
    cwd: externalHost,
    stdio: 'inherit',
  });

  // Standalone embedded ResponseRenderer using precomputed FoundationRuntime.ingest() payload.
  await page.goto(`${baseUrl}/?embed=1`);
  await page.getByLabel('Host reading').getByText('99 books').waitFor();
  assert.equal(await page.getByLabel('Message').count(), 0);
  const embedAxe = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  assert.deepEqual(embedAxe.violations, []);

  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);

  writeFileSync(
    join(artifactsHost, 'report.json'),
    JSON.stringify(
      {
        tarball: tarballPath,
        externalHost,
        verifiedAt: new Date().toISOString(),
        checks: {
          compiledDistWithoutSrc: true,
          pureNodeEsmServerCheck: true,
          strictDtsCheckWithoutAllowTsExtensions: true,
          viteBuildClientBoundaryClean: true,
          unauthenticatedApiRejectedWith401: true,
          httpTurnsAndSqlPersistence: true,
          serverSortPaginateRefresh: true,
          precomputedIngestEmbeddedMode: true,
          pythonWireOraclePassed: true,
          axeWcag21AaViolations: 0,
        },
      },
      null,
      2,
    ),
  );
  console.log(
    `Independent external compiled consumer passed all checks (tarball=${tarballName}, external=${externalHost})`,
  );
} finally {
  await browser.close().catch(() => {});
  if (serverProcess && !serverProcess.killed) {
    const exited = new Promise((resolveExit) => serverProcess.once('exit', resolveExit));
    serverProcess.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  try {
    rmSync(externalHost, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Best-effort temp cleanup on Windows file handles.
  }
}
