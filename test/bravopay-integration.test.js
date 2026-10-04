import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/database.js';
import { paymentProvider } from '../src/paymentProvider.js';
import { Services } from '../src/services.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const ledger = new Map(); const calls = [];
  let failNext;
  const config = { paymentsMode: 'BRAVOPAY', database: ':memory:', origin: 'http://127.0.0.1',
    encryptionKey: randomBytes(32).toString('hex'),
    bravoPay: { baseUrl: 'https://bravopay.club/api/v1', secretKey: 'test-key', webhookSecret: 'test-webhook' },
    providerDependencies: { fetch: async (url, options) => {
      calls.push({ method: options.method || 'GET', url });
      assert.equal(url.startsWith('https://bravopay.club/api/v1/transactions'), true);
      if (options.method === 'POST') {
        const input = JSON.parse(options.body);
        const transaction = { id: `tx_${randomUUID()}`, object: 'transaction', status: 'PENDING', method: 'PIX',
          amount_cents: input.amount_cents, currency: 'BRL', external_reference: input.external_reference,
          created_at: new Date().toISOString(), pix: { copy_paste: 'not-a-real-pix-code', expires_at: new Date(Date.now() + 3600000).toISOString() } };
        if (failNext === 'timeout-before') { failNext = null; throw new Error('test timeout before response'); }
        if (failNext === 'rejected') { failNext = null; return new Response(JSON.stringify({ error: { code: 'validation_error', message: config.bravoPay.secretKey } }), { status: 422 }); }
        ledger.set(input.external_reference, transaction);
        if (failNext === 'timeout-after') { failNext = null; throw new Error('test timeout after commit'); }
        if (failNext === 'early-webhook') {
          failNext = null;
          const signed = signature(transaction, 'PAID');
          const response = await fetch(`${config.origin}/api/webhooks/payment`, { method: 'POST', headers: signed.headers, body: signed.body });
          assert.equal(response.status, 200);
        }
        return new Response(JSON.stringify(transaction));
      }
      const ref = new URL(url).searchParams.get('external_reference');
      const tx = ledger.get(ref);
      return new Response(JSON.stringify({ data: tx ? [tx] : [], has_more: false, next_cursor: null }));
    } }
  };
  function signature(tx, status = 'PAID', overrides = {}, type) {
    const types = { PENDING: 'transaction.created', PAID: 'transaction.paid', REFUNDED: 'transaction.refunded', EXPIRED: 'transaction.expired', CHARGEBACK: 'transaction.chargeback' };
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: type || types[status], created: timestamp, data: { ...tx, status, ...overrides } });
    const signature = createHmac('sha256', config.bravoPay.webhookSecret).update(`${timestamp}.${body}`).digest('hex');
    return { body, headers: { 'Content-Type': 'application/json', 'BravoPay-Signature': `t=${timestamp},v1=${signature}` } };
  }
  const { server, db } = createApp(config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { const close = once(server, 'close'); server.close(); server.closeAllConnections(); await close; });
  const token = randomBytes(32).toString('hex');
  const api = async (path, options = {}) => {
    const response = await fetch(config.origin + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, data: await response.json() };
  };
  const input = { serviceType: 'CONSULTA', name: 'Pessoa Teste', cpf: '52998224725' };
  const create = (key = randomUUID(), body = input) => api('/api/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const webhook = signed => api('/api/webhooks/payment', { method: 'POST', headers: signed.headers, body: signed.body });
  return { ledger, calls, config, db, api, create, webhook, signature, input, fail: type => { failNext = type; } };
}

test('BravoPay HTTP: criação persistida, preços backend, consulta e confirmação autenticada', async t => {
  const app = await fixture(t);
  assert.equal((await app.create(randomUUID(), { ...app.input, amount: 1 })).status, 400);
  assert.equal((await app.create(randomUUID(), { ...app.input, status: 'PAID' })).status, 400);
  const created = await app.create();
  assert.equal(created.status, 201); assert.equal(created.data.status, 'PENDING');
  assert.equal(created.data.provider, 'BRAVOPAY'); assert.equal(created.data.pix.copyPaste, 'not-a-real-pix-code');
  const persisted = app.db.prepare('SELECT * FROM payments WHERE service_id=?').get(created.data.id);
  assert.equal(persisted.provider_payment_id, created.data.paymentId); assert.equal(persisted.amount_cents, 3000);
  assert.equal(persisted.provider_status, 'PENDING'); assert.ok(persisted.created_at); assert.equal(persisted.operation_state, 'CONFIRMED');
  assert.equal((await app.api(`/api/services/${created.data.id}?status=paid`)).data.status, 'PENDING');
  app.ledger.get(created.data.id).status = 'PAID';
  const status = await app.api(`/api/services/${created.data.id}`);
  assert.equal(status.data.status, 'PAID'); assert.equal(status.data.result, null);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM results').get().n, 0);
});

test('Criação simultânea da mesma operação nunca repete POST ou solicitações', async t => {
  const app = await fixture(t); const key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 5 }, () => app.create(key)));
  assert.ok(responses.some(response => response.status === 201));
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM services').get().n, 1);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
  const retry = await app.create(key);
  assert.equal(retry.status, 201);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal((await app.create(key, { ...app.input, name: 'Outra pessoa' })).status, 409);
});

test('Timeout após criação é reconciliado por referência, sem outra cobrança', async t => {
  const app = await fixture(t); app.fail('timeout-after');
  const created = await app.create();
  assert.equal(created.status, 201); assert.equal(created.data.status, 'PENDING');
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'GET']);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
});

test('Timeout inconclusivo é persistido; retries e reinicialização lógica apenas reconciliam', async t => {
  const app = await fixture(t); app.fail('timeout-before'); const key = randomUUID();
  const created = await app.create(key);
  assert.equal(created.status, 503); assert.equal(created.data.error, 'PAYMENT_RECONCILIATION_PENDING');
  const stored = app.db.prepare('SELECT * FROM payments').get();
  assert.equal(stored.operation_state, 'SUBMITTING'); assert.equal(stored.provider_payment_id, null);
  assert.equal((await app.create(key)).status, 503);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
  app.ledger.set(stored.service_id, { id: 'tx_recovered', object: 'transaction', status: 'PAID', method: 'PIX', amount_cents: 3000,
    currency: 'BRL', external_reference: stored.service_id, created_at: new Date().toISOString() });
  const recovered = await app.create(key);
  assert.equal(recovered.status, 201); assert.equal(recovered.data.status, 'PAID');
  assert.equal(recovered.data.id, stored.service_id);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
});

test('Rejeição normalizada não vaza dados nem cria nova cobrança em retry', async t => {
  const app = await fixture(t); app.fail('rejected'); const key = randomUUID();
  const failed = await app.create(key);
  assert.equal(failed.status, 502); assert.equal(failed.data.error, 'PAYMENT_REJECTED');
  assert.ok(!JSON.stringify(failed.data).includes(app.config.bravoPay.secretKey));
  assert.equal((await app.create(key)).data.status, 'FAILED');
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
});

test('Webhook cruza ID, pedido e valor; duplicados são processados uma vez', async t => {
  const app = await fixture(t); const created = (await app.create()).data;
  const tx = app.ledger.get(created.id);
  assert.equal((await app.webhook(app.signature(tx, 'PAID', { id: 'tx_wrong' }))).status, 409);
  assert.equal((await app.webhook(app.signature(tx, 'PAID', { external_reference: 'order_unknown' }))).status, 404);
  assert.equal((await app.webhook(app.signature(tx, 'PAID', { amount_cents: 5000 }))).status, 409);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM webhook_events').get().n, 0);
  const signed = app.signature(tx);
  const results = await Promise.all(Array.from({ length: 5 }, () => app.webhook(signed)));
  assert.ok(results.every(result => result.status === 200));
  assert.equal(results.filter(result => result.data.duplicate).length, 4);
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit WHERE action='BRAVOPAY_PAYMENT_PAID'").get().n, 1);
  assert.equal(app.calls.filter(call => call.method === 'GET').length, 0);
  assert.equal(app.db.prepare('SELECT status FROM services').get().status, 'PAID');
});

test('Webhook antes da resposta da criação não sofre regressão para PENDING', async t => {
  const app = await fixture(t); app.fail('early-webhook');
  const created = await app.create();
  assert.equal(created.status, 201); assert.equal(created.data.status, 'PAID');
});

test('Eventos refund, expired e chargeback são confirmados sem inventar endpoint de reembolso', async t => {
  const app = await fixture(t);
  for (const state of ['REFUNDED', 'EXPIRED', 'CHARGEBACK']) {
    const created = (await app.create()).data; const tx = app.ledger.get(created.id);
    if (state !== 'EXPIRED') await app.webhook(app.signature(tx, 'PAID'));
    assert.equal((await app.webhook(app.signature(tx, state))).status, 200);
    const payment = app.db.prepare('SELECT * FROM payments WHERE service_id=?').get(created.id);
    assert.equal(payment.payment_state, state === 'CHARGEBACK' ? 'FAILED' : state);
    assert.equal(payment.provider_status, state);
    assert.equal((await app.webhook(app.signature(tx, 'PAID'))).data.ignored, true);
  }
});

test('Reabertura do banco preserva operação incerta e impede POST após restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bp-restart-'));
  const path = join(directory, 'test.sqlite');
  let posts = 0;
  const config = { paymentsMode: 'BRAVOPAY', encryptionKey: randomBytes(32).toString('hex'),
    bravoPay: { baseUrl: 'https://bravopay.club/api/v1', secretKey: 'test-key', webhookSecret: 'test-webhook' },
    providerDependencies: { fetch: async (url, options) => {
      if (options.method === 'POST') { posts++; throw new Error('Test connection lost'); }
      return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }));
    } }
  };
  const body = { serviceType: 'CONSULTA', name: 'Pessoa Teste', cpf: '52998224725' };
  let db;
  try {
    db = openDatabase(path);
    await assert.rejects(new Services(db, paymentProvider(config, db), config).create('owner', 'idempotency-restart-key', body), { code: 'PAYMENT_RECONCILIATION_PENDING' });
    const original = db.prepare('SELECT * FROM payments').get();
    db.close(); db = openDatabase(path);
    await assert.rejects(new Services(db, paymentProvider(config, db), config).create('owner', 'idempotency-restart-key', body), { code: 'PAYMENT_RECONCILIATION_PENDING' });
    assert.equal(db.prepare('SELECT * FROM payments').get().idempotency_key, original.idempotency_key);
    assert.equal(db.prepare('SELECT count(*) AS n FROM services').get().n, 1);
    assert.equal(posts, 1);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
