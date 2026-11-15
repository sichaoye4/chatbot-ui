import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve('.');
const name = `consumer-${Date.now()}`;
execFileSync(process.execPath, ['scripts/package-foundation-v2.mjs', name], {
  cwd: root,
  stdio: 'inherit',
});
const packageDir = resolve(root, 'artifacts/foundation-sdk', name);
const host = resolve(root, 'artifacts/foundation-consumer', name);
mkdirSync(join(host, 'node_modules', '@source'), { recursive: true });
cpSync(resolve(root, 'tests/consumer/foundation-v2'), host, { recursive: true });
renameSync(join(host, 'server-check.txt'), join(host, 'server-check.ts'));
cpSync(packageDir, join(host, 'node_modules/@source/chat-foundation-v2'), { recursive: true });
execFileSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig',
    '--noEmit',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--jsx',
    'react-jsx',
    '--allowImportingTsExtensions',
    '--strict',
    '--skipLibCheck',
    '--types',
    'node',
    join(host, 'server-check.ts'),
  ],
  { cwd: root, stdio: 'inherit' },
);
execFileSync(process.execPath, ['--import', 'tsx', join(host, 'server-check.ts')], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(
  process.execPath,
  [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', host, '--outDir', join(host, 'build')],
  { cwd: root, stdio: 'inherit' },
);

const build = join(host, 'build');
for (const file of readdirSync(join(build, 'assets')).filter((name) => name.endsWith('.js'))) {
  const source = readFileSync(join(build, 'assets', file), 'utf8');
  assert.doesNotMatch(source, /node:sqlite|node:crypto|DEEPSEEK_API_KEY/);
}
const server = createServer((request, reply) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = resolve(build, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(build + sep)) {
    reply.writeHead(403).end();
    return;
  }
  try {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    reply.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    reply.end(readFileSync(file));
  } catch {
    reply.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(`http://127.0.0.1:${server.address().port}/`))
      external.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const composer = page.getByLabel('Message');
  await composer.fill('Show library inventory');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByLabel('Host reading').getByText('42 books').waitFor();
  await composer.fill('Show energy capacity');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByLabel('Host reading').getByText('17 MW').waitFor();
  await page.reload();
  await page.getByLabel('Host reading').getByText('42 books').waitFor();
  await page.getByLabel('Host reading').getByText('17 MW').waitFor();
  const serialized = await page.evaluate(() =>
    localStorage.getItem('independent-foundation-conversation'),
  );
  assert.ok(serialized);
  const wire = join(host, 'wire-snapshot.json');
  writeFileSync(wire, serialized);
  execFileSync('python', [join(host, 'wire_check.py'), wire], { cwd: root, stdio: 'inherit' });
  await page.goto(`http://127.0.0.1:${server.address().port}/?embed=1`);
  await page.getByLabel('Host reading').getByText('42 books').waitFor();
  assert.equal(await page.getByLabel('Message').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    `Independent packaged consumer passed two domains, custom view, events, restored host history and standalone embedding: ${host}`,
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
