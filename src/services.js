import { createHmac, randomUUID } from 'node:crypto';
import { audit, transaction } from './database.js';
import { HttpError, normalizeCpf, encrypt, decrypt, hash } from './security.js';

export const PRICES = Object.freeze({ CONSULTA: 3000, ABERTURA: 5000 });
export const DONATIONS = Object.freeze({ suggested: [1000, 2500, 5000, 10000, 20000], min: 500, max: 100000 });

export class Services {
  constructor(db, paymentProvider, config) { this.db = db; this.paymentProvider = paymentProvider; this.config = config; }
  create(owner, idem, body) {
    if (!/^[\w-]{16,100}$/.test(idem || '')) throw new HttpError(400, 'Chave de idempotência inválida.');
    const donation = body?.serviceType === 'DOACAO';
    const allowed = donation ? ['serviceType', 'amount'] : ['serviceType', 'cpf', 'name', 'description'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
      throw new HttpError(400, 'Campos não permitidos. O valor é definido pelo servidor.');
    }
    if (!donation && (typeof body.serviceType !== 'string' || !Object.hasOwn(PRICES, body.serviceType))) throw new HttpError(400, 'Serviço inválido.');
    const amount = donation ? body.amount : PRICES[body.serviceType];
    if (donation && (!Number.isSafeInteger(amount) || amount < DONATIONS.min || amount > DONATIONS.max)) throw new HttpError(400, 'Informe uma doação entre R$ 5,00 e R$ 1.000,00.');
    if (donation && this.config.paymentsMode === 'BRAVOPAY' && !this.config.donationBeneficiary) throw new HttpError(503, 'Arrecadação indisponível: beneficiário ainda não verificado.');
    const cpf = donation ? '' : normalizeCpf(body.cpf);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!donation && (name.length < 3 || name.length > 120)) throw new HttpError(400, 'Informe um nome entre 3 e 120 caracteres.');
    if (description.length > 2000 || (body.serviceType === 'ABERTURA' && description.length < 10)) {
      throw new HttpError(400, 'Descreva a abertura com 10 a 2000 caracteres.');
    }
    const sensitive = { cpf, name, description };
    const fingerprint = createHmac('sha256', this.config.encryptionKey).update(JSON.stringify({ serviceType: body.serviceType, ...(donation ? { amount } : {}), ...sensitive })).digest('hex');
    if (this.config.paymentsMode === 'BRAVOPAY') return this.createBravoOperation({ owner, idem, fingerprint, type: body.serviceType, amount, sensitive });
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM services WHERE owner=? AND idem=?').get(owner, idem);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'Chave já utilizada com outros dados.');
        return this.read(owner, existing.id);
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO services VALUES(?,?,?,?,?,?,?,?,?)').run(
        id, owner, idem, fingerprint, body.serviceType, amount,
        encrypt(sensitive, this.config.encryptionKey, id), 'PENDING', new Date().toISOString()
      );
      const payment = this.paymentProvider.createPayment({ serviceId: id, amount, currency: 'BRL', idempotencyKey: hash(`${owner}:${idem}`) });
      if (!payment || typeof payment.id !== 'string' || !payment.id || payment.status !== 'PENDING') {
        throw new Error('Payment provider returned an invalid creation result.');
      }
      this.db.prepare("INSERT INTO payments(id,service_id,status,provider_payment_id,amount_cents,created_at) VALUES(?,?,'PENDING',?,?,?)")
        .run(payment.id, id, payment.id, amount, new Date().toISOString());
      audit(this.db, id, 'SANDBOX_SERVICE_CREATED');
      return this.read(owner, id);
    });
  }
  read(owner, id) {
    const row = this.db.prepare('SELECT * FROM services WHERE id=? AND owner=?').get(id, owner);
    if (!row) throw new HttpError(404, 'Solicitação não encontrada nesta sessão.');
    const payment = this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(id);
    const result = row.status === 'PAID' ? this.db.prepare('SELECT sensitive FROM results WHERE service_id=?').get(id) : null;
    return {
      id, serviceType: row.type, amount: row.amount, currency: 'BRL', status: payment.payment_state || row.status,
      paymentId: payment.provider_payment_id || payment.id, environment: 'HOMOLOGATION', created: row.created,
      ...(payment.provider === 'BRAVOPAY' ? { provider: 'BRAVOPAY', pix: payment.instructions ? decrypt(payment.instructions, this.config.encryptionKey, `${id}:payment`) : null } : {}),
      result: result ? decrypt(result.sensitive, this.config.encryptionKey, `${id}:result`) : null
    };
  }
  webhook(rawBody, headers) {
    const event = this.paymentProvider.verifyWebhook(headers, rawBody);
    const fingerprint = hash(rawBody);
    if (this.config.paymentsMode === 'BRAVOPAY') return this.webhookBravo(event, fingerprint);
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT fingerprint FROM webhook_events WHERE id=?').get(event.eventId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'Evento repetido com conteúdo diferente.');
        return { received: true, duplicate: true };
      }
      const payment = this.paymentProvider.getPaymentStatus(event.paymentId);
      if (!payment || payment.id !== event.paymentId) throw new Error('Payment provider returned a mismatched payment.');
      const localPayment = this.db.prepare('SELECT service_id FROM payments WHERE id=?').get(payment.id);
      if (!localPayment) throw new HttpError(404, 'Pagamento não encontrado.');
      const service = this.db.prepare('SELECT * FROM services WHERE id=?').get(localPayment.service_id);
      if (event.amount !== service.amount) throw new HttpError(409, 'Valor divergente do serviço.');
      const transitions = { PENDING: ['PAID', 'FAILED'], PAID: ['REFUNDED'], FAILED: [], REFUNDED: [] };
      this.db.prepare('INSERT INTO webhook_events VALUES(?,?,?)').run(event.eventId, fingerprint, new Date().toISOString());
      if (!transitions[service.status].includes(event.status)) {
        audit(this.db, service.id, 'SANDBOX_STALE_EVENT_IGNORED');
        return { received: true, ignored: true };
      }
      this.db.prepare('UPDATE payments SET status=? WHERE id=?').run(event.status, payment.id);
      this.db.prepare('UPDATE services SET status=? WHERE id=?').run(event.status, service.id);
      audit(this.db, service.id, `SANDBOX_PAYMENT_${event.status}`);
      if (event.status === 'PAID' && service.type !== 'DOACAO') {
        const result = service.type === 'CONSULTA'
          ? { fictitious: true, message: 'Consulta fictícia concluída. Nenhum dado institucional foi consultado.', processes: [{ protocol: `DEMO-${service.id.slice(0, 8)}`, status: 'Exemplo em análise' }] }
          : { fictitious: true, message: 'Abertura fictícia registrada. Nenhum processo institucional foi aberto.', protocol: `DEMO-${service.id.slice(0, 8)}` };
        this.db.prepare('INSERT INTO results VALUES(?,?)').run(service.id, encrypt(result, this.config.encryptionKey, `${service.id}:result`));
        audit(this.db, service.id, 'SANDBOX_FICTITIOUS_SERVICE_COMPLETED');
      }
      return { received: true };
    });
  }
  async createBravoOperation(input) {
    const { owner, idem, fingerprint, type, amount, sensitive } = input;
    const operation = transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM services WHERE owner=? AND idem=?').get(owner, idem);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'Chave já utilizada com outros dados.');
        const payment = this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(existing.id);
        if (payment.provider !== 'BRAVOPAY') throw new HttpError(409, 'Operação pertence a outro provider.');
        return { id: existing.id, payment, reconcileOnly: true };
      }
      const id = randomUUID();
      const created = new Date().toISOString();
      this.db.prepare('INSERT INTO services VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, idem, fingerprint, type, amount,
        encrypt(sensitive, this.config.encryptionKey, id), 'PENDING', created);
      this.db.prepare(`INSERT INTO payments(id,service_id,status,provider,amount_cents,created_at,payment_state,idempotency_key,operation_state)
        VALUES(?,?,'PENDING','BRAVOPAY',?,?,'PENDING',?,'SUBMITTING')`).run(`operation_${id}`, id, amount, created, hash(`${owner}:${idem}`));
      audit(this.db, id, 'BRAVOPAY_SERVICE_CREATED');
      return { id, payment: this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(id), reconcileOnly: false };
    });
    if (operation.payment.provider_payment_id || operation.payment.operation_state === 'REJECTED') return this.read(owner, operation.id);
    let payment;
    try {
      // Nenhuma transação SQLite fica aberta durante I/O. Retentativas apenas reconciliam.
      payment = await this.paymentProvider.createPayment({ serviceId: operation.id, amount, currency: 'BRL',
        idempotencyKey: operation.payment.idempotency_key, ...(type === 'DOACAO' ? {} : { customer: { name: sensitive.name, cpf: sensitive.cpf } }), reconcileOnly: operation.reconcileOnly });
    } catch (error) {
      if (['PAYMENT_REJECTED', 'PAYMENT_PROVIDER_AUTH_ERROR'].includes(error.code)) transaction(this.db, () => {
        this.db.prepare("UPDATE payments SET operation_state='REJECTED',status='FAILED',payment_state='FAILED' WHERE service_id=? AND provider_payment_id IS NULL").run(operation.id);
        this.db.prepare("UPDATE services SET status='FAILED' WHERE id=? AND status='PENDING' AND NOT EXISTS(SELECT 1 FROM payments WHERE service_id=? AND provider_payment_id IS NOT NULL)").run(operation.id, operation.id);
        audit(this.db, operation.id, 'BRAVOPAY_PAYMENT_REJECTED');
      });
      throw error;
    }
    transaction(this.db, () => {
      const local = this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(operation.id);
      this.applyBravoPayment(local, payment);
      if (payment.pix) this.db.prepare('UPDATE payments SET instructions=? WHERE service_id=?').run(encrypt(payment.pix, this.config.encryptionKey, `${operation.id}:payment`), operation.id);
    });
    return this.read(owner, operation.id);
  }
  async refresh(owner, id) {
    const current = this.read(owner, id);
    if (this.config.paymentsMode !== 'BRAVOPAY') return current;
    const local = this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(id);
    if (local.provider !== 'BRAVOPAY' || !local.provider_payment_id) return current;
    const confirmed = await this.paymentProvider.getPaymentStatus(local.provider_payment_id);
    transaction(this.db, () => this.applyBravoPayment(this.db.prepare('SELECT * FROM payments WHERE service_id=?').get(id), confirmed));
    return this.read(owner, id);
  }
  webhookBravo(event, fingerprint) {
    if (event.ignored) return { received: true, ignored: true };
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT fingerprint FROM webhook_events WHERE id=?').get(event.eventId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'Evento repetido com conteúdo diferente.');
        return { received: true, duplicate: true };
      }
      const payment = this.db.prepare("SELECT * FROM payments WHERE provider='BRAVOPAY' AND service_id=?").get(event.orderId);
      if (!payment) throw new HttpError(404, 'Pagamento não encontrado.');
      const ignored = this.applyBravoPayment(payment, { ...event, id: event.paymentId });
      this.db.prepare('INSERT INTO webhook_events VALUES(?,?,?)').run(event.eventId, fingerprint, new Date().toISOString());
      return { received: true, ...(ignored ? { ignored: true } : {}) };
    });
  }
  applyBravoPayment(local, confirmed) {
    if (confirmed.orderId !== local.service_id || confirmed.amount !== local.amount_cents || confirmed.currency !== 'BRL' ||
        (local.provider_payment_id && local.provider_payment_id !== confirmed.id)) throw new HttpError(409, 'Pagamento divergente da operação.');
    const other = this.db.prepare("SELECT service_id FROM payments WHERE provider='BRAVOPAY' AND provider_payment_id=?").get(confirmed.id);
    if (other && other.service_id !== local.service_id) throw new HttpError(409, 'Pagamento divergente da operação.');
    const state = local.payment_state || 'PENDING';
    const transitions = { PENDING: ['PAID', 'FAILED', 'EXPIRED', 'REFUNDED'], PAID: ['REFUNDED', 'FAILED'], FAILED: [], EXPIRED: [], REFUNDED: [] };
    if (!Object.hasOwn(transitions, confirmed.status)) throw new Error('Invalid provider payment status.');
    this.db.prepare("UPDATE payments SET provider_payment_id=?,operation_state='CONFIRMED',created_at=COALESCE(?,created_at) WHERE id=?").run(confirmed.id, confirmed.createdAt || null, local.id);
    if (state === confirmed.status) {
      this.db.prepare('UPDATE payments SET provider_status=? WHERE id=?').run(confirmed.providerStatus, local.id);
      return false;
    }
    if (!transitions[state].includes(confirmed.status)) { audit(this.db, local.service_id, 'BRAVOPAY_STALE_EVENT_IGNORED'); return true; }
    // Mantém o CHECK legado e expõe EXPIRED pelo estado aditivo, sem reconstruir tabelas.
    const legacyState = confirmed.status === 'EXPIRED' ? 'FAILED' : confirmed.status;
    this.db.prepare('UPDATE payments SET status=?,payment_state=?,provider_status=? WHERE id=?').run(legacyState, confirmed.status, confirmed.providerStatus, local.id);
    this.db.prepare('UPDATE services SET status=? WHERE id=?').run(legacyState, local.service_id);
    audit(this.db, local.service_id, `BRAVOPAY_PAYMENT_${confirmed.status}`);
    return false;
  }
}
