import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';

const config = loadConfig();
const [paymentId, status = 'PAID', eventId = randomUUID()] = process.argv.slice(2);
if (!paymentId || !['PAID', 'FAILED', 'REFUNDED'].includes(status)) throw new Error('Uso: npm run sandbox:event -- sandbox_ID [PAID|FAILED|REFUNDED] [eventId]');
const db = openDatabase(config.database);
const payment = db.prepare('SELECT s.amount FROM payments p JOIN services s ON p.service_id=s.id WHERE p.id=?').get(paymentId);
db.close();
if (!payment) throw new Error('Pagamento sandbox não encontrado.');
const body = JSON.stringify({ eventId, paymentId, status, amount: payment.amount, currency: 'BRL' });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', config.webhookSecret).update(`${timestamp}.${body}`).digest('hex');
const response = await fetch(`${config.origin}/api/webhooks/sandbox`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sandbox-Timestamp': timestamp, 'X-Sandbox-Signature': signature }, body
});
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
