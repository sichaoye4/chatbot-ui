import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const roots = [
  'packages/contracts/foundation.ts',
  'packages/contracts/protocol.ts',
  'packages/contracts/visualization.ts',
  'packages/contracts/visualization-validation.ts',
  'packages/contracts/visualization-v2.ts',
  'packages/contracts/geography.ts',
  'packages/contracts/calendar.ts',
  'packages/contracts/pie-data.ts',
  'packages/contracts/project-validation.ts',
  'packages/contracts/project-v2.ts',
  'packages/catalog/foundation.ts',
  'packages/catalog/builtins.ts',
  'packages/server-runtime/foundation.ts',
  'packages/server-runtime/controls.ts',
  'packages/server-runtime/control-store.ts',
  'packages/agent-adapter/foundation.ts',
];
const allowed = new Set(roots.map((file) => resolve(file)));
for (const file of roots) {
  const source = readFileSync(file, 'utf8');
  // Conservative static source guard. Only reviewed relative modules and zod are allowed.
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])([^'"]+)\1/g)) {
    const target = match[2];
    if (target === 'zod') continue;
    const dependency = resolve(dirname(file), target);
    if (!target.startsWith('.') || !allowed.has(dependency))
      throw new Error(
        `${file} imports outside the isolated foundation: ${relative('.', dependency)}`,
      );
  }
  if (/\b(?:import|require)\s*\(/.test(source))
    throw new Error(`${file}: dynamic imports require an explicit boundary review`);
}
console.log(
  `Foundation import boundary passed (${roots.length} modules; no v1, example or app imports).`,
);
