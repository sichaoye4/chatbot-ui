import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Compile and package @source/chat-foundation-v2 into an isolated compiled ESM + .d.ts package.
// Follow the actual import closure so the package does not depend on the monorepo.
const workspace = resolve('.');
const base = resolve(workspace, 'artifacts', 'foundation-sdk');
const name = process.argv[2];
if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Provide an output name');
const out = resolve(base, name);
if (!out.startsWith(base + sep) || existsSync(out))
  throw new Error('Output must be new and inside artifacts/foundation-sdk');
const roots = ['contracts', 'react', 'client', 'server'].map((entry) =>
  resolve(workspace, `packages/foundation-sdk/${entry}.ts`),
);
const seen = new Set();
function visit(file) {
  if (seen.has(file)) return;
  const path = relative(workspace, file);
  if (isAbsolute(path) || path.startsWith('..') || !path.startsWith(`packages${sep}`))
    throw new Error(`Dependency outside packages: ${file}`);
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  if (/\b(?:import|require)\s*\(\s*[^'"\s]/.test(source))
    throw new Error(`Dynamic import requires review: ${path}`);
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
    else if (
      !['react', 'react-dom', 'react/jsx-runtime', 'zod'].includes(specifier) &&
      !specifier.startsWith('node:')
    )
      throw new Error(`Undeclared dependency ${specifier} in ${path}`);
  }
  const target = resolve(out, 'src', path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
}
for (const root of roots) visit(root);

const css = 'packages/renderer-openui/foundation.css';
mkdirSync(resolve(out, 'dist'), { recursive: true });
copyFileSync(resolve(workspace, css), resolve(out, 'dist', 'styles.css'));

const entrySources = ['contracts', 'react', 'client', 'server'].map((entry) =>
  resolve(out, 'src', 'packages', 'foundation-sdk', `${entry}.ts`),
);

execFileSync(
  process.execPath,
  [
    resolve(workspace, 'node_modules/typescript/bin/tsc'),
    '--ignoreConfig',
    '--rootDir',
    resolve(out, 'src', 'packages'),
    '--outDir',
    resolve(out, 'dist'),
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--lib',
    'ES2023,DOM,DOM.Iterable',
    '--jsx',
    'react-jsx',
    '--declaration',
    '--declarationMap',
    '--sourceMap',
    '--rewriteRelativeImportExtensions',
    '--strict',
    '--skipLibCheck',
    '--types',
    'node',
    ...entrySources,
  ],
  { cwd: workspace, stdio: 'inherit' },
);

function walkFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

for (const file of walkFiles(resolve(out, 'dist'))) {
  if (!file.endsWith('.js')) continue;
  const content = readFileSync(file, 'utf8');
  if (/(?:from|import)\s+['"]\.[^'"]*\.tsx?['"]/.test(content)) {
    throw new Error(`Unrewritten .ts/.tsx import specifier in compiled output: ${file}`);
  }
}

writeFileSync(
  resolve(out, 'package.json'),
  JSON.stringify(
    {
      name: '@source/chat-foundation-v2',
      version: '0.1.0-experimental',
      type: 'module',
      exports: {
        './contracts': {
          types: './dist/foundation-sdk/contracts.d.ts',
          default: './dist/foundation-sdk/contracts.js',
        },
        './react': {
          types: './dist/foundation-sdk/react.d.ts',
          default: './dist/foundation-sdk/react.js',
        },
        './client': {
          types: './dist/foundation-sdk/client.d.ts',
          default: './dist/foundation-sdk/client.js',
        },
        './server': {
          types: './dist/foundation-sdk/server.d.ts',
          default: './dist/foundation-sdk/server.js',
        },
        './styles.css': './dist/styles.css',
      },
      files: ['dist'],
      peerDependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', zod: '^4.0.0' },
      engines: { node: '>=24.14.0' },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged ${seen.size} compiled modules in ${out}`);
