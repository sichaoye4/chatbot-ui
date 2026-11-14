import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const forbidden = ['DEEPSEEK_API_KEY', 'llm_key.txt', 'node:fs', 'node:sqlite'];
for (const file of readdirSync('dist/client/assets')) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(join('dist/client/assets', file), 'utf8');
  for (const term of forbidden)
    if (source.includes(term)) throw new Error(`Server-only identifier in client bundle: ${term}`);
}
console.log(
  'Client boundary verified: no provider credential configuration or server filesystem/database imports.',
);
