import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BravoPayProvider } from '../src/bravoPayProvider.js';

const config = { baseUrl: 'https://bravopay.club/api/v1', secretKey: 'test-api-key', webhookSecret: 'test-webhook-secret' };
const input = { serviceId: 'order_test', amount: 3000, currency: 'BRL', idempotencyKey: 'operation_test', customer: { name: 'Pessoa Teste', cpf: '52998224725' } };
const transaction = (extra = {}) => ({ id: 'tx_test', object: 'transaction', method: 'PIX', status: 'PENDING', amount_cents: 3000,
  currency: 'BRL', created_at: '2026-06-01T15:30:00.000Z', external_reference: 'order_test',
  pix: { copy_paste: 'example-only-not-a-payment-code', expires_at: '2026-06-01T16:30:00.000Z' }, ...extra });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const list = (items = []) => json({ data: items, has_more: false, next_cursor: null });
const provider = fetch => new BravoPayProvider(config, { fetch, resolvePayment: id => id === 'tx_test' ? { serviceId: 'order_test', amount: 3000 } : null });
const event = (extra = {}) => ({ id: 'evt_test', type: 'transaction.paid', created: Math.floor(Date.now() / 1000), data: transaction({ status: 'PAID' }), ...extra });
const signed = (payload, timestamp = Math.floor(Date.now() / 1000)) => {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', config.webhookSecret).update(`${timestamp}.`).update(body).digest('hex');
  return { body, headers: { 'bravopay-signature': `t=${timestamp},v1=${signature}` } };
};

test('Criação PIX usa somente contrato documentado e normaliza resposta sem PII', async () => {
  const calls = [];
  const instance = provider(async (url, options) => { calls.push({ url, options }); return json(transaction({ external_reference: undefined })); });
  const payment = await instance.createPayment(input);
  assert.equal(payment.status, 'PENDING'); assert.equal(payment.orderId, input.serviceId);
  assert.equal(calls[0].url, `${config.baseUrl}/transactions`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { amount_cents: 3000, method: 'pix', external_reference: 'order_test', customer: input.customer });
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${config.secretKey}`);
  assert.equal(calls[0].options.headers['Idempotency-Key'], input.idempotencyKey);
  assert.equal(calls[0].options.redirect, 'error'); assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(payment).includes(input.customer.cpf));
  assert.equal(new BravoPayProvider(config).assertReady(), undefined);
});

for (const [status, code] of [[400, 'PAYMENT_REJECTED'], [401, 'PAYMENT_PROVIDER_AUTH_ERROR'], [403, 'PAYMENT_PROVIDER_AUTH_ERROR'],
  [404, 'PAYMENT_NOT_FOUND'], [409, 'PAYMENT_PENDING'], [422, 'PAYMENT_REJECTED'], [429, 'PAYMENT_PROVIDER_RATE_LIMITED'],
  [500, 'PAYMENT_PROVIDER_UNAVAILABLE'], [502, 'PAYMENT_PROVIDER_UNAVAILABLE'], [503, 'PAYMENT_PROVIDER_UNAVAILABLE'], [504, 'PAYMENT_PROVIDER_UNAVAILABLE']]) {
  test(`HTTP ${status}: erro normalizado sem vazar resposta externa`, async () => {
    const instance = provider(async () => json({ error: { code: 'external', message: `${config.secretKey} ${input.customer.cpf}` } }, status, { 'Retry-After': '60' }));
    await assert.rejects(instance.request('/transactions'), error => {
      assert.equal(error.code, code); assert.equal(error.retryAfter, 60);
      assert.ok(!error.message.includes(config.secretKey)); assert.ok(!error.message.includes(input.customer.cpf)); return true;
    });
  });
}

test('Criação rejeitada não tenta reconciliar nem reenviar cobrança', async () => {
  let count = 0;
  const instance = provider(async () => { count++; return json({ error: { code: 'validation_error' } }, 422); });
  await assert.rejects(instance.createPayment(input), { code: 'PAYMENT_REJECTED' });
  assert.equal(count, 1);
});

test('Timeout usa sinal explícito e reconcilia sem repetir POST', async () => {
  const calls = [];
  const instance = new BravoPayProvider(config, { timeoutMs: 10, fetch: async (url, options) => {
    calls.push(options.method || 'GET');
    if (options.method === 'POST') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    assert.equal(new URL(url).searchParams.get('external_reference'), input.serviceId);
    return list([transaction({ status: 'PAID' })]);
  } });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal((await instance.createPayment(input)).status, 'PAID'); }
  finally { clearTimeout(keepAlive); }
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('Timeout inconclusivo e retry permanecem pendentes sem nova criação', async () => {
  const calls = [];
  const instance = provider(async (url, options) => {
    calls.push(options.method || 'GET');
    if (options.method === 'POST') throw new Error('Network lost');
    return list();
  });
  await assert.rejects(instance.createPayment(input), { code: 'PAYMENT_RECONCILIATION_PENDING' });
  await assert.rejects(instance.createPayment({ ...input, reconcileOnly: true }), { code: 'PAYMENT_RECONCILIATION_PENDING' });
  assert.deepEqual(calls, ['POST', 'GET', 'GET']);
});

test('HTTP 200 malformado ou aprovação na criação não simula sucesso', async () => {
  for (const invalid of [null, {}, transaction({ amount_cents: 1 }), transaction({ currency: 'USD' }), transaction({ status: 'UNKNOWN' }),
    transaction({ status: 'PAID' }), transaction({ id: null }), transaction({ pix: null }), transaction({ created_at: 'invalid' }), transaction({ external_reference: 'wrong-order' })]) {
    const instance = provider(async (url, options) => options.method === 'POST' ? json(invalid) : list());
    await assert.rejects(instance.createPayment(input), { code: 'PAYMENT_RECONCILIATION_PENDING' });
  }
  await assert.rejects(provider(async () => new Response('not-json')).request('/transactions'), { code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
});

test('Status consulta endpoint de listagem por referência com validação estrita', async () => {
  const instance = provider(async url => {
    const parsed = new URL(url); assert.equal(parsed.pathname, '/api/v1/transactions');
    assert.equal(parsed.searchParams.get('external_reference'), input.serviceId);
    return list([transaction({ status: 'PAID' })]);
  });
  assert.equal((await instance.getPaymentStatus('tx_test')).status, 'PAID');
  assert.throws(() => instance.getPaymentStatus('tx_unknown'), { code: 'PAYMENT_NOT_FOUND' });
  for (const change of [{ id: 'tx_other' }, { amount_cents: 5000 }, { currency: 'USD' }, { status: 'UNKNOWN' }, { external_reference: 'order_other' }]) {
    await assert.rejects(provider(async () => list([transaction(change)])).getPaymentStatus('tx_test'), { code: 'PAYMENT_PROVIDER_INVALID_RESPONSE' });
  }
  await assert.rejects(provider(async () => list()).getPaymentStatus('tx_test'), { code: 'PAYMENT_NOT_FOUND' });
  await assert.rejects(provider(async () => list([transaction(), transaction({ id: 'tx_other' })])).getPaymentStatus('tx_test'), { code: 'PAYMENT_RECONCILIATION_CONFLICT' });
});

test('Paginação usa cursor documentado e rejeita cursor repetido', async () => {
  let count = 0;
  const instance = provider(async url => {
    count++;
    if (count === 1) return json({ data: [], has_more: true, next_cursor: 'tx_cursor' });
    assert.equal(new URL(url).searchParams.get('cursor'), 'tx_cursor');
    return list([transaction()]);
  });
  assert.equal((await instance.getPaymentStatus('tx_test')).status, 'PENDING');
  await assert.rejects(provider(async () => json({ data: [], has_more: true, next_cursor: 'same' })).getPaymentStatus('tx_test'), { code: 'PAYMENT_PROVIDER_INVALID_RESPONSE' });
});

test('Webhook válido: raw body, alias, assinatura segura e anti-replay', () => {
  const instance = provider(() => { throw new Error('Webhook não faz rede'); });
  const valid = signed(event());
  assert.equal(instance.verifyWebhook(valid.headers, valid.body).status, 'PAID');
  assert.equal(instance.verifyWebhook({ 'x-bravopay-signature': valid.headers['bravopay-signature'] }, valid.body).orderId, input.serviceId);
  for (const headers of [{}, { 'bravopay-signature': 't=123,v1=short' }, { ...valid.headers, 'x-bravopay-signature': 'different' },
    { 'bravopay-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }]) assert.throws(() => instance.verifyWebhook(headers, valid.body), { status: 401 });
  const expired = signed(event(), Math.floor(Date.now() / 1000) - 301);
  assert.throws(() => instance.verifyWebhook(expired.headers, expired.body), { status: 401 });
  assert.throws(() => instance.verifyWebhook(valid.headers, Buffer.concat([valid.body, Buffer.from(' ')])), { status: 401 });
  assert.throws(() => instance.verifyWebhook(valid.headers, JSON.parse(valid.body)), { status: 400 });
});

test('Webhook valida envelope, status, referência, moeda, valor e ID', () => {
  const instance = provider(() => {});
  for (const invalid of [event({ id: '' }), event({ created: null }), event({ type: 'transaction.unknown' }),
    event({ data: transaction({ status: 'PENDING' }) }), event({ data: transaction({ id: '' }) }),
    event({ data: transaction({ status: 'PAID', external_reference: null }) }),
    event({ data: transaction({ status: 'PAID', amount_cents: -1 }) }), event({ data: transaction({ status: 'PAID', currency: 'USD' }) })]) {
    const signature = signed(invalid); assert.throws(() => instance.verifyWebhook(signature.headers, signature.body), { status: 400 });
  }
  const receipt = signed(event({ type: 'transaction.receipt_uploaded' }));
  assert.equal(instance.verifyWebhook(receipt.headers, receipt.body).ignored, true);
  const undocumented = signed(event({ type: 'transaction.failed' }));
  assert.throws(() => instance.verifyWebhook(undocumented.headers, undocumented.body), { code: 'INTEGRATION_PENDING' });
});

test('Mapeamento explícito de todos os estados e chargeback bloqueia serviço', () => {
  const instance = provider(() => {});
  for (const [raw, expected] of [['PENDING','PENDING'],['PAID','PAID'],['FAILED','FAILED'],['EXPIRED','EXPIRED'],['REFUNDED','REFUNDED'],['CHARGEBACK','FAILED']]) {
    const normalized = instance.normalize(transaction({ status: raw }));
    assert.equal(normalized.status, expected); assert.equal(normalized.providerStatus, raw);
  }
});

test('Reembolso e repetição são explicitamente pendentes, sem endpoint inventado', () => {
  let calls = 0;
  const instance = provider(() => { calls++; });
  for (let i = 0; i < 2; i++) assert.throws(() => instance.refundPayment('tx_test', 3000), { code: 'INTEGRATION_PENDING', status: 501 });
  assert.equal(calls, 0);
});
