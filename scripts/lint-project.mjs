import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const errors = [];

async function filesUnder(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else result.push(path);
  }
  return result;
}

const coreRoot = join(root, 'assets/scripts/core');
for (const path of await filesUnder(coreRoot)) {
  if (extname(path) !== '.ts') continue;
  const source = await readFile(path, 'utf8');
  const name = relative(root, path);
  if (/from\s+['"]cc['"]|import\s+['"]cc['"]/.test(source)) errors.push(`${name}: core must not import Cocos`);
  if (/\bconsole\.(log|warn|error)\s*\(/.test(source)) errors.push(`${name}: core must not write console output`);
}

for (const path of await filesUnder(join(root, 'assets/config'))) {
  if (extname(path) !== '.json') continue;
  try { JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { errors.push(`${relative(root, path)}: invalid JSON (${error.message})`); }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Project architecture and JSON checks passed.\n');
}
