import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
for (const directory of ['src', 'public/js', 'tests']) {
  for (const file of await fs.readdir(path.join(root, directory))) {
    if (!/\.(mjs|js|cjs)$/.test(file)) continue;
    execFileSync(process.execPath, ['--check', path.join(root, directory, file)], { stdio: 'inherit' });
    checked++;
  }
}
console.log(`语法检查通过：${checked} 个模块`);
