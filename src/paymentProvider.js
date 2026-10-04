import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError } from './security.js';
import { BravoPayProvider } from './bravoPayProvider.js';

/** Simulador local. Assinatura e payload próprios, sem equivalência com BravoPay. */
export class SandboxPaymentProvider {
  constructor(db, secret) { this.db = db; this.secret = secret; }
  createPayment(data) {
    if (!data || !data.serviceId || !Number.isInteger(data.amount) || data.amount <= 0 || data.currency !== 'BRL' || !data.idempotencyKey) {
      throw new HttpError(400, 'Dados internos do pagamento inválidos.');
    }
    const id = `sandbox_${randomUUID()}`;
    return { id, status: 'PENDING' };
  }
  getPaymentStatus(paymentId) {
    const payment = this.db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId);
    if (!payment) throw new HttpError(404, 'Pagamento não encontrado.');
    return { id: payment.id, status: payment.status };
  }
  verifyWebhook(headers, body) {
    if (!Buffer.isBuffer(body)) throw new HttpError(400, 'Webhook requer corpo bruto.');
    const timestamp = headers['x-sandbox-timestamp'];
    const signature = headers['x-sandbox-signature'];
    if (!/^\d{10}$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f\d]{64}$/i.test(signature || '')) {
      throw new HttpError(401, 'Webhook não autenticado.');
    }
    const expected = createHmac('sha256', this.secret).update(`${timestamp}.`).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new HttpError(401, 'Webhook não autenticado.');
    let event;
    try { event = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Evento inválido.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        Object.keys(event).sort().join(',') !== 'amount,currency,eventId,paymentId,status' ||
        !/^[\w-]{1,100}$/.test(event.eventId || '') || typeof event.paymentId !== 'string' ||
        !['PAID', 'FAILED', 'REFUNDED'].includes(event.status) || !Number.isInteger(event.amount) || event.currency !== 'BRL') {
      throw new HttpError(400, 'Evento inválido.');
    }
    return event;
  }
  refundPayment(paymentId, amount) {
    void paymentId; void amount;
    throw new HttpError(501, 'Reembolso sandbox: envie um evento REFUNDED pelo simulador server-to-server.');
  }
}

export function paymentProvider(config, db) {
  const mode = config.paymentsMode;
  if (mode === 'SANDBOX') return new SandboxPaymentProvider(db, config.webhookSecret);
  if (mode === 'BRAVOPAY') {
    const provider = new BravoPayProvider(config.bravoPay, {
      ...config.providerDependencies,
      resolvePayment: paymentId => db?.prepare('SELECT p.service_id AS serviceId, s.amount FROM payments p JOIN services s ON s.id=p.service_id WHERE p.provider=? AND p.provider_payment_id=?').get('BRAVOPAY', paymentId)
    });
    provider.assertReady();
    return provider;
  }
  throw new Error('Unsupported PAYMENTS_MODE.');
}
