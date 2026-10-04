import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { normalizeCpf, encrypt, decrypt } from '../src/security.js';
import { loadConfig } from '../src/config.js';
import { BravoPayProvider } from '../src/bravoPayProvider.js';

test('CPF: normaliza e rejeita inválidos, repetidos e conteúdo não numérico', () => {
  assert.equal(normalizeCpf('529.982.247-25'), '52998224725');
  for (const cpf of ['11111111111', '52998224726', '5299822472', '', null, '529abc98224725']) {
    assert.throws(() => normalizeCpf(cpf));
  }
});

test('AES-GCM: não revela CPF e autentica chave, conteúdo e contexto', () => {
  const key = randomBytes(32).toString('hex');
  const data = { cpf: '52998224725', name: 'Pessoa Teste' };
  const encrypted = encrypt(data, key, 'one');
  assert.ok(!encrypted.includes(data.cpf));
  assert.deepEqual(decrypt(encrypted, key, 'one'), data);
  assert.notEqual(encrypted, encrypt(data, key, 'one'));
  assert.throws(() => decrypt(encrypted, key, 'other'));
  assert.throws(() => decrypt(encrypted, randomBytes(32).toString('hex'), 'one'));
  const altered = JSON.parse(encrypted); altered.tag = '0'.repeat(32);
  assert.throws(() => decrypt(JSON.stringify(altered), key, 'one'));
});

test('Configuração bloqueia produção, modo real e segredos ausentes', () => {
  for (const env of [{}, { APP_ENV: 'production', PAYMENTS_MODE: 'SANDBOX' }, { APP_ENV: 'homologation', PAYMENTS_MODE: 'LIVE' }, { APP_ENV: 'homologation', PAYMENTS_MODE: 'SANDBOX' }]) {
    assert.throws(() => loadConfig(env));
  }
});

test('BravoPay: operações não simulam sucesso; reembolso sem contrato permanece pendente', () => {
  const provider = new BravoPayProvider({ baseUrl: 'https://bravopay.club/api/v1', publicKey: 'test', secretKey: 'test', webhookSecret: 'test' });
  assert.throws(() => provider.createPayment(), { code: 'PAYMENT_REJECTED' });
  assert.throws(() => provider.getPaymentStatus(), { code: 'PAYMENT_NOT_FOUND' });
  assert.throws(() => provider.verifyWebhook({}, Buffer.from('{}')), { status: 401 });
  assert.throws(() => provider.refundPayment('tx_test', 3000), { code: 'INTEGRATION_PENDING' });
});
