import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/server.js';
import { openDatabase } from '../src/database.js';

test('Fluxos HTTP, persistência, pagamentos autenticados e deduplicação', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'homologation-'));
  const config = { paymentsMode: 'SANDBOX', database: join(directory, 'test.sqlite'), encryptionKey: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex'), origin: 'http://127.0.0.1' };
  const { server, db } = createApp(config);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base;
  const token = randomBytes(32).toString('hex');
  const body = { serviceType: 'CONSULTA', name: 'Pessoa Teste', cpf: '52998224725' };
  let service;
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const create = (data = body, idem = randomUUID(), headers = {}) => call('/api/services', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idem, ...headers }, body: JSON.stringify(data)
  });
  const webhook = (event, overrides = {}) => {
    const raw = JSON.stringify(event);
    const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', config.webhookSecret).update(`${timestamp}.${raw}`).digest('hex');
    return call(overrides.path || '/api/webhooks/sandbox', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Sandbox-Timestamp': timestamp,
      'X-Sandbox-Signature': overrides.signature || signature
    }, body: overrides.raw || raw });
  };
  const event = (data, status = 'PAID') => ({ eventId: randomUUID(), paymentId: data.paymentId, status, amount: data.amount, currency: 'BRL' });
  try {
    await t.test('catalogo preserva sandbox e identifica o responsavel', async () => {
      const catalog = await call('/api/catalog');
      assert.equal(catalog.data.paymentsMode, 'SANDBOX');
      assert.deepEqual(catalog.data.prices, { CONSULTA: 3000, ABERTURA: 5000 });
      const page = await fetch(base);
      const html = await page.text();
      assert.match(html, /lang="pt-BR"/); assert.match(html, /MeuINSS.net/);
      assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
      const frontend = await (await fetch(`${base}/app.js`)).text();
      assert.ok(!frontend.includes('BRAVOPAY_'));
      for (const sensitive of [config.webhookSecret, config.encryptionKey]) assert.ok(!JSON.stringify(catalog.data).includes(sensitive));
    });
    await t.test('preço, CPF, serviço, sessão, origem e corpo são validados', async () => {
      assert.equal((await create({ ...body, amount: 1 })).status, 400);
      assert.equal((await create({ ...body, status: 'PAID' })).status, 400);
      assert.equal((await create({ ...body, cpf: '11111111111' })).status, 400);
      assert.equal((await create({ ...body, serviceType: 'toString' })).status, 400);
      assert.equal((await create({ ...body, serviceType: { toString: 'CONSULTA' } })).status, 400);
      assert.equal((await create(body, randomUUID(), { Authorization: '' })).status, 401);
      assert.equal((await create(body, randomUUID(), { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await create({ ...body, description: 'a'.repeat(20000) })).status, 413);
    });
    await t.test('solicitações simultâneas com a mesma chave criam um pagamento', async () => {
      const idem = randomUUID();
      const requests = await Promise.all(Array.from({ length: 8 }, () => create(body, idem)));
      assert.ok(requests.every(item => item.status === 201));
      service = requests[0].data;
      assert.ok(requests.every(item => item.data.id === service.id));
      assert.equal(service.amount, 3000); assert.equal(service.status, 'PENDING');
      assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
      assert.equal((await create({ ...body, name: 'Outro nome' }, idem)).status, 409);
      const row = db.prepare('SELECT * FROM services WHERE id=?').get(service.id);
      assert.ok(!row.sensitive.includes(body.cpf)); assert.ok(!row.sensitive.includes(body.name));
      assert.ok(!JSON.stringify(row).includes(token));
    });
    await t.test('outra sessão não acessa e redirecionamento nunca confirma', async () => {
      assert.equal((await call(`/api/services/${service.id}`, { headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}` } })).status, 404);
      const status = await call(`/api/services/${service.id}?status=paid`);
      assert.equal(status.data.status, 'PENDING'); assert.equal(status.data.result, null);
      assert.equal((await call(`/api/services/${service.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'PAID' }) })).status, 404);
    });
    await t.test('assinatura, timestamp, corpo, moeda e valor são verificados', async () => {
      const paid = event(service);
      assert.equal((await webhook(paid, { signature: '0'.repeat(64) })).status, 401);
      assert.equal((await webhook(paid, { timestamp: String(Math.floor(Date.now() / 1000) - 1000) })).status, 401);
      assert.equal((await webhook(paid, { raw: JSON.stringify({ ...paid, status: 'REFUNDED' }) })).status, 401);
      assert.equal((await webhook({ ...paid, amount: 1 })).status, 409);
      assert.equal((await webhook({ ...paid, currency: 'USD' })).status, 400);
      assert.equal((await webhook(null)).status, 400);
      assert.equal((await webhook({ ...paid, paymentId: 'sandbox_unknown' })).status, 404);
      assert.equal(db.prepare('SELECT count(*) AS n FROM webhook_events').get().n, 0);
    });
    await t.test('pagamento confirmado, evento repetido e resultado processado uma vez', async () => {
      const paid = event(service);
      const requests = await Promise.all(Array.from({ length: 5 }, () => webhook(paid)));
      assert.ok(requests.every(item => item.status === 200));
      assert.equal(requests.filter(item => item.data.duplicate).length, 4);
      assert.equal((await webhook({ ...paid, status: 'FAILED' })).status, 409);
      const read = (await call(`/api/services/${service.id}`)).data;
      assert.equal(read.status, 'PAID'); assert.equal(read.result.fictitious, true);
      assert.equal(db.prepare('SELECT count(*) AS n FROM results').get().n, 1);
      await webhook(event(service));
      assert.equal((await webhook(event(service), { path: '/api/webhooks/payment' })).status, 200);
      assert.equal(db.prepare("SELECT count(*) AS n FROM audit WHERE action='SANDBOX_FICTITIOUS_SERVICE_COMPLETED'").get().n, 1);
    });
    await t.test('reembolso e eventos antigos não restauram resultado', async () => {
      assert.equal((await webhook(event(service, 'REFUNDED'))).status, 200);
      await webhook(event(service));
      const read = (await call(`/api/services/${service.id}`)).data;
      assert.equal(read.status, 'REFUNDED'); assert.equal(read.result, null);
    });
    await t.test('abertura exige descrição, gera protocolo fictício e recusa é final', async () => {
      assert.equal((await create({ ...body, serviceType: 'ABERTURA' })).status, 400);
      const opening = (await create({ ...body, serviceType: 'ABERTURA', description: 'Solicitação fictícia para teste' })).data;
      assert.equal(opening.amount, 5000);
      await webhook(event(opening));
      assert.match((await call(`/api/services/${opening.id}`)).data.result.protocol, /^DEMO-/);
      const failed = (await create()).data;
      await webhook(event(failed, 'FAILED')); await webhook(event(failed));
      assert.equal((await call(`/api/services/${failed.id}`)).data.status, 'FAILED');
    });
    await t.test('transação desfaz evento, status e auditoria se processamento falhar', async () => {
      const created = (await create()).data;
      db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON results BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
      const paid = event(created);
      const log = [];
      const originalWrite = process.stderr.write;
      process.stderr.write = chunk => { log.push(String(chunk)); return true; };
      try {
        const response = await webhook(paid);
        assert.equal(response.status, 500);
        assert.equal(response.data.error, 'Falha interna. Tente novamente.');
        assert.ok(!JSON.stringify(response.data).includes(config.webhookSecret));
      } finally { process.stderr.write = originalWrite; }
      const output = log.join('');
      assert.match(output, /INTERNAL_ERROR/);
      for (const sensitive of [body.cpf, config.webhookSecret, config.encryptionKey, token]) assert.ok(!output.includes(sensitive));
      assert.equal((await call(`/api/services/${created.id}`)).data.status, 'PENDING');
      assert.equal(db.prepare('SELECT count(*) AS n FROM webhook_events WHERE id=?').get(paid.eventId).n, 0);
      db.exec('DROP TRIGGER fail_result');
      assert.equal((await webhook(paid)).status, 200);
    });
    await t.test('rate limit responde 429', async () => {
      let status = 200;
      for (let i = 0; i < 121 && status !== 429; i++) status = (await call('/api/health')).status;
      assert.equal(status, 429);
      const authenticated = await webhook(event(service));
      assert.equal(authenticated.status, 200);
      assert.equal(authenticated.data.ignored, true);
      const auditRows = JSON.stringify(db.prepare('SELECT * FROM audit').all());
      for (const sensitive of [body.cpf, config.webhookSecret, config.encryptionKey, token]) assert.ok(!auditRows.includes(sensitive));
    });
  } finally {
    const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
  }
  try {
    const reopened = openDatabase(config.database);
    assert.equal(reopened.prepare('SELECT status FROM services WHERE id=?').get(service.id).status, 'REFUNDED');
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
