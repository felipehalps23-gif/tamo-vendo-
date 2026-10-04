import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';

const directory = mkdtempSync(join(tmpdir(), 'sandbox-e2e-'));
const { server } = createApp({
  paymentsMode: 'SANDBOX',
  database: join(directory, 'test.sqlite'), encryptionKey: randomBytes(32).toString('hex'),
  webhookSecret: 'sandbox-e2e-secret-only-for-ephemeral-tests', origin: 'http://127.0.0.1:3100'
});
server.listen(3100, '127.0.0.1');
const shutdown = () => {
  server.close(() => { rmSync(directory, { recursive: true, force: true }); });
  server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
