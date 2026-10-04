import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, normalizeCpf } from './security.js';

export class PendingIntegrationError extends HttpError {
  constructor(operation) { super(501, `BravoPay: ${operation} pendente de documentação oficial.`); this.code = 'INTEGRATION_PENDING'; }
}
export class ProviderConfigurationError extends Error {
  constructor() { super('BravoPay provider is not configured.'); this.code = 'BRAVOPAY_NOT_CONFIGURED'; }
}
export class PaymentProviderError extends HttpError {
  constructor(code, status = 502, uncertain = false) {
    super(status, code); this.code = code; this.uncertain = uncertain;
  }
}

// Chargeback bloqueia o serviço como FAILED, preservando o status original.
const statuses = Object.freeze({ PENDING: 'PENDING', PAID: 'PAID', FAILED: 'FAILED', EXPIRED: 'EXPIRED', REFUNDED: 'REFUNDED', CHARGEBACK: 'FAILED' });
const transactionEvents = Object.freeze({
  'transaction.created': 'PENDING', 'transaction.paid': 'PAID',
  'transaction.refunded': 'REFUNDED', 'transaction.chargeback': 'CHARGEBACK', 'transaction.expired': 'EXPIRED'
});
const validId = value => typeof value === 'string' && /^[\w-]{1,120}$/.test(value);

export class BravoPayProvider {
  constructor(config = {}, dependencies = {}) {
    this.config = config;
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.resolvePayment = dependencies.resolvePayment || (() => null);
    this.timeoutMs = dependencies.timeoutMs || 4000;
  }
  assertReady() {
    if (['baseUrl', 'secretKey', 'webhookSecret'].some(key => typeof this.config[key] !== 'string' || !this.config[key].trim())) throw new ProviderConfigurationError();
    let url;
    try { url = new URL(this.config.baseUrl); } catch { throw new ProviderConfigurationError(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\r\n]/.test(this.config.secretKey)) throw new ProviderConfigurationError();
    // PUBLIC_KEY é reservada: a documentação exige somente Bearer API key.
  }
  async request(path, options = {}) {
    this.assertReady();
    let response;
    try {
      response = await this.fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.config.secretKey}`, 'Content-Type': 'application/json', ...options.headers }
      });
      if (!response.ok) {
        const codes = { 400: 'PAYMENT_REJECTED', 401: 'PAYMENT_PROVIDER_AUTH_ERROR', 403: 'PAYMENT_PROVIDER_AUTH_ERROR',
          404: 'PAYMENT_NOT_FOUND', 409: 'PAYMENT_PENDING', 422: 'PAYMENT_REJECTED', 429: 'PAYMENT_PROVIDER_RATE_LIMITED' };
        const error = new PaymentProviderError(codes[response.status] || 'PAYMENT_PROVIDER_UNAVAILABLE', response.status === 404 ? 404 : 502,
          options.method === 'POST' && (response.status >= 500 || [409, 429].includes(response.status)));
        const retry = response.headers.get('retry-after');
        if (/^\d{1,6}$/.test(retry || '')) error.retryAfter = Number(retry);
        throw error;
      }
      if (response.status !== 200) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE', 502, options.method === 'POST');
      const text = await response.text();
      if (text.length > 262144) throw new Error('Oversized response');
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      throw new PaymentProviderError('PAYMENT_PROVIDER_UNAVAILABLE', 502, options.method === 'POST');
    }
  }
  normalize(transaction, expected = {}) {
    if (!transaction || !validId(transaction.id) || !Number.isSafeInteger(transaction.amount_cents) || transaction.amount_cents < 500 ||
        transaction.currency !== 'BRL' || typeof transaction.status !== 'string' || !Object.hasOwn(statuses, transaction.status) ||
        (expected.paymentId && transaction.id !== expected.paymentId) ||
        (expected.amount !== undefined && transaction.amount_cents !== expected.amount) ||
        (expected.orderId && transaction.external_reference !== expected.orderId)) {
      throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE');
    }
    if (typeof transaction.created_at !== 'string' || !Number.isFinite(Date.parse(transaction.created_at))) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE');
    let pix;
    if (transaction.pix?.copy_paste !== undefined) {
      if (typeof transaction.pix.copy_paste !== 'string' || !transaction.pix.copy_paste || !Number.isFinite(Date.parse(transaction.pix.expires_at))) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE');
      pix = { copyPaste: transaction.pix.copy_paste, expiresAt: transaction.pix.expires_at };
    }
    return { id: transaction.id, status: statuses[transaction.status], providerStatus: transaction.status,
      amount: transaction.amount_cents, currency: transaction.currency, orderId: transaction.external_reference, createdAt: transaction.created_at,
      ...(pix ? { pix } : {}) };
  }
  async findTransaction(expected) {
    let cursor;
    const cursors = new Set();
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '100', external_reference: expected.orderId });
      if (cursor) query.set('cursor', cursor);
      const result = await this.request(`/transactions?${query}`);
      if (!result || !Array.isArray(result.data) || typeof result.has_more !== 'boolean' || result.data.length > 100) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE');
      // Referência exclusiva da operação: múltiplas cobranças exigem revisão manual.
      if (result.data.length > 1 || (result.data.length && result.has_more)) throw new PaymentProviderError('PAYMENT_RECONCILIATION_CONFLICT');
      if (result.data.length) return this.normalize(result.data[0], expected);
      if (!result.has_more) throw new PaymentProviderError('PAYMENT_NOT_FOUND', 404);
      if (!validId(result.next_cursor) || cursors.has(result.next_cursor)) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE');
      cursor = result.next_cursor; cursors.add(cursor);
    }
    throw new PaymentProviderError('PAYMENT_RECONCILIATION_PENDING', 503);
  }
  createPayment(data) {
    this.assertReady();
    if (!data || !validId(data.serviceId) || !Number.isSafeInteger(data.amount) || data.amount < 500 || data.currency !== 'BRL' || !validId(data.idempotencyKey)) throw new PaymentProviderError('PAYMENT_REJECTED', 400);
    return this.createTransaction(data);
  }
  async createTransaction(data) {
    const expected = { orderId: data.serviceId, amount: data.amount };
    if (data.reconcileOnly) {
      try { return await this.findTransaction(expected); }
      catch (error) {
        if (error.code === 'PAYMENT_NOT_FOUND') throw new PaymentProviderError('PAYMENT_RECONCILIATION_PENDING', 503, true);
        throw error;
      }
    }
    const body = { amount_cents: data.amount, method: 'pix', external_reference: data.serviceId };
    if (data.customer) body.customer = { name: data.customer.name, cpf: normalizeCpf(data.customer.cpf) };
    try {
      const transaction = await this.request('/transactions', { method: 'POST', headers: { 'Idempotency-Key': data.idempotencyKey }, body: JSON.stringify(body) });
      // O retorno de criação documentado não inclui external_reference.
      const payment = this.normalize(transaction, { amount: data.amount });
      if ((transaction.external_reference !== undefined && transaction.external_reference !== data.serviceId) ||
          payment.status !== 'PENDING' || transaction.object !== 'transaction' || transaction.method !== 'PIX' ||
          typeof transaction.pix?.copy_paste !== 'string' || !transaction.pix.copy_paste || !Number.isFinite(Date.parse(transaction.pix.expires_at))) throw new PaymentProviderError('PAYMENT_PROVIDER_INVALID_RESPONSE', 502, true);
      return { ...payment, orderId: data.serviceId, pix: { copyPaste: transaction.pix.copy_paste, expiresAt: transaction.pix.expires_at } };
    } catch (error) {
      if (error.code === 'PAYMENT_PROVIDER_INVALID_RESPONSE') error.uncertain = true;
      if (!(error instanceof PaymentProviderError) || !error.uncertain) throw error;
      try { return await this.findTransaction(expected); }
      catch { throw new PaymentProviderError('PAYMENT_RECONCILIATION_PENDING', 503, true); }
    }
  }
  getPaymentStatus(paymentId) {
    this.assertReady();
    if (!validId(paymentId)) throw new PaymentProviderError('PAYMENT_NOT_FOUND', 404);
    const operation = this.resolvePayment(paymentId);
    if (!operation) throw new PaymentProviderError('PAYMENT_NOT_FOUND', 404);
    return this.findTransaction({ orderId: operation.serviceId, amount: operation.amount, paymentId });
  }
  verifyWebhook(headers, rawBody) {
    this.assertReady();
    if (!Buffer.isBuffer(rawBody)) throw new HttpError(400, 'Webhook requer corpo bruto.');
    const canonical = headers['bravopay-signature'];
    const alias = headers['x-bravopay-signature'];
    if (canonical && alias && canonical !== alias) throw new HttpError(401, 'Webhook não autenticado.');
    const match = typeof (canonical || alias) === 'string' && (canonical || alias).match(/^t=(\d{10}),v1=([a-f\d]{64})$/i);
    if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300) throw new HttpError(401, 'Webhook não autenticado.');
    const expected = createHmac('sha256', this.config.webhookSecret).update(`${match[1]}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) throw new HttpError(401, 'Webhook não autenticado.');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new HttpError(400, 'Evento inválido.'); }
    if (!event || !validId(event.id) || !event.id.startsWith('evt_') || !Number.isSafeInteger(event.created) || event.created <= 0 || typeof event.type !== 'string') throw new HttpError(400, 'Evento inválido.');
    if (['withdrawal.paid', 'withdrawal.failed', 'transaction.receipt_uploaded'].includes(event.type)) return { eventId: event.id, ignored: true };
    if (event.type === 'transaction.failed') throw new PendingIntegrationError('transaction.failed data');
    if (!Object.hasOwn(transactionEvents, event.type) || event.data?.status !== transactionEvents[event.type] || !validId(event.data.external_reference)) throw new HttpError(400, 'Evento inválido.');
    let payment;
    try { payment = this.normalize(event.data, { orderId: event.data.external_reference }); }
    catch { throw new HttpError(400, 'Evento inválido.'); }
    return { eventId: event.id, paymentId: payment.id, orderId: payment.orderId, amount: payment.amount, currency: payment.currency,
      status: payment.status, providerStatus: payment.providerStatus, createdAt: payment.createdAt };
  }
  refundPayment(paymentId, amount) {
    this.assertReady(); void paymentId; void amount;
    throw new PendingIntegrationError('refundPayment (endpoint não documentado)');
  }
}
