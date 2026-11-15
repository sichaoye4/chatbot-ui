import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// A source distribution for TypeScript-aware bundlers, not a compiled npm release.
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
mkdirSync(resolve(out, 'src', dirname(css)), { recursive: true });
copyFileSync(resolve(workspace, css), resolve(out, 'src', css));
writeFileSync(
  resolve(out, 'package.json'),
  JSON.stringify(
    {
      name: '@source/chat-foundation-v2',
      version: '0.1.0-experimental',
      type: 'module',
      exports: {
        './contracts': './src/packages/foundation-sdk/contracts.ts',
        './react': './src/packages/foundation-sdk/react.ts',
        './client': './src/packages/foundation-sdk/client.ts',
        './server': './src/packages/foundation-sdk/server.ts',
        './styles.css': './src/packages/renderer-openui/foundation.css',
      },
      peerDependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', zod: '^4.0.0' },
      engines: { node: '>=24.14.0' },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged ${seen.size} source modules in ${out}`);
