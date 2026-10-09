import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const directory of ['src', 'public']) {
  for (const name of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const checked = spawnSync(process.execPath, ['--check', join(directory, name)], { stdio: 'inherit' });
    if (checked.status !== 0) process.exit(checked.status || 1);
  }
}
mkdirSync('dist', { recursive: true });
for (const directory of ['src', 'public']) cpSync(directory, join('dist', directory), { recursive: true });
for (const name of ['package.json', 'package-lock.json']) cpSync(name, join('dist', name));
process.stdout.write('Build validado e preparado em dist (sem secrets ou banco).\n');
