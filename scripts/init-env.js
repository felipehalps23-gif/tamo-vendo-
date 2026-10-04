import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const template = readFileSync('.env.example', 'utf8')
  .replace('DATA_ENCRYPTION_KEY=', `DATA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`)
  .replace('SANDBOX_WEBHOOK_SECRET=', `SANDBOX_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`);
writeFileSync('.env', template, { flag: 'wx', mode: 0o600 });
console.log('.env de homologação criado.');
