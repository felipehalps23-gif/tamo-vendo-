import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { paymentProvider, SandboxPaymentProvider } from '../src/paymentProvider.js';
import { BravoPayProvider } from '../src/bravoPayProvider.js';
import { Services } from '../src/services.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const credentials = { baseUrl: 'https://bravopay.club/api/v1', publicKey: 'test-public', secretKey: 'test-private', webhookSecret: 'test-webhook' };

test('Seleção explícita sem fallback; BravoPay sem configuração falha', () => {
  const db = openDatabase(':memory:');
  try {
    assert.ok(paymentProvider({ paymentsMode: 'SANDBOX', webhookSecret: 'test' }, db) instanceof SandboxPaymentProvider);
    for (const config of [{}, { ...credentials, secretKey: '' }, { ...credentials, webhookSecret: ' ' }]) {
      assert.throws(() => paymentProvider({ paymentsMode: 'BRAVOPAY', bravoPay: config }, db), {
        code: 'BRAVOPAY_NOT_CONFIGURED', message: 'BravoPay provider is not configured.'
      });
    }
    assert.ok(paymentProvider({ paymentsMode: 'BRAVOPAY', bravoPay: credentials }, db) instanceof BravoPayProvider);
    for (const paymentsMode of [undefined, 'LIVE', 'sandbox']) assert.throws(() => paymentProvider({ paymentsMode }, db));
    assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n, 0);
    assert.throws(() => createApp({ paymentsMode: 'BRAVOPAY', database: 'must-not-open.sqlite' }), { code: 'BRAVOPAY_NOT_CONFIGURED' });
  } finally { db.close(); }
});

test('BravoPay: assinaturas exatas e nenhuma operação retorna sucesso sem configuração', () => {
  const provider = new BravoPayProvider();
  for (const [name, count] of [['createPayment', 1], ['getPaymentStatus', 1], ['verifyWebhook', 2], ['refundPayment', 2]]) {
    assert.equal(provider[name].length, count);
    assert.equal(SandboxPaymentProvider.prototype[name].length, count);
    assert.throws(() => provider[name](), { code: 'BRAVOPAY_NOT_CONFIGURED' });
  }
});

test('Configuração lê as quatro variáveis BravoPay somente no servidor', () => {
  const config = loadConfig({ APP_ENV: 'homologation', PAYMENTS_MODE: 'BRAVOPAY', DATABASE_PATH: ':memory:',
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    BRAVOPAY_BASE_URL: credentials.baseUrl, BRAVOPAY_PUBLIC_KEY: credentials.publicKey,
    BRAVOPAY_SECRET_KEY: credentials.secretKey, BRAVOPAY_WEBHOOK_SECRET: credentials.webhookSecret
  });
  assert.equal(config.paymentsMode, 'BRAVOPAY'); assert.deepEqual(config.bravoPay, credentials);
});

test('Inicialização BRAVOPAY encerra controladamente sem expor secrets', () => {
  for (const configured of [false]) {
    const secret = randomBytes(32).toString('hex');
    const result = spawnSync(process.execPath, ['src/server.js'], { encoding: 'utf8', env: {
      ...process.env, APP_ENV: 'homologation', PAYMENTS_MODE: 'BRAVOPAY',
      DATA_ENCRYPTION_KEY: secret, BRAVOPAY_BASE_URL: configured ? credentials.baseUrl : '',
      BRAVOPAY_PUBLIC_KEY: configured ? credentials.publicKey : '', BRAVOPAY_SECRET_KEY: secret,
      BRAVOPAY_WEBHOOK_SECRET: secret
    } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BravoPay provider is not configured\./);
    assert.ok(!result.stderr.includes(secret)); assert.equal(result.stdout, '');
  }
});

test('Contrato sandbox preserva bytes do corpo e comparação segura de assinatura', () => {
  const secret = randomBytes(32).toString('hex');
  const provider = new SandboxPaymentProvider(null, secret);
  const body = Buffer.from('{ "eventId":"test-event", "paymentId":"test-payment", "status":"PAID", "amount":3000, "currency":"BRL" }');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-sandbox-timestamp': timestamp, 'x-sandbox-signature': createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex') };
  assert.equal(provider.verifyWebhook(headers, body).status, 'PAID');
  assert.throws(() => provider.verifyWebhook(headers, Buffer.from(JSON.stringify(JSON.parse(body)))), { status: 401 });
  assert.throws(() => provider.verifyWebhook({ ...headers, 'x-sandbox-signature': 'a' }, body), { status: 401 });
  assert.throws(() => provider.verifyWebhook(headers, JSON.parse(body)), { status: 400 });
  assert.throws(() => provider.refundPayment('test-payment', 3000), { status: 501 });
});

test('Persistência pertence à aplicação; criação aprovada artificialmente desfaz a operação', () => {
  const db = openDatabase(':memory:');
  const config = { encryptionKey: randomBytes(32).toString('hex') };
  const observed = [];
  const provider = { createPayment: data => { observed.push(data); return { id: 'not-real', status: 'PAID' }; } };
  const services = new Services(db, provider, config);
  try {
    assert.throws(() => services.create('owner', 'idempotency-test-key', { serviceType: 'CONSULTA', cpf: '52998224725', name: 'Pessoa Teste' }), /invalid creation result/);
    assert.equal(observed[0].amount, 3000);
    assert.notEqual(observed[0].idempotencyKey, 'idempotency-test-key');
    for (const table of ['services', 'payments', 'audit']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  } finally { db.close(); }
});
