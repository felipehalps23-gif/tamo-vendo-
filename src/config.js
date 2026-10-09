import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadConfig(env = process.env) {
  if (env.APP_ENV !== 'homologation' || !['SANDBOX', 'BRAVOPAY'].includes(env.PAYMENTS_MODE)) {
    throw new Error('APP_ENV deve ser homologation e PAYMENTS_MODE deve ser SANDBOX ou BRAVOPAY. Produção pendente.');
  }
  if (!/^[a-f\d]{64}$/i.test(env.DATA_ENCRYPTION_KEY || '')) {
    throw new Error('DATA_ENCRYPTION_KEY deve conter 32 bytes em hexadecimal.');
  }
  if (env.PAYMENTS_MODE === 'SANDBOX' && (env.SANDBOX_WEBHOOK_SECRET || '').length < 32) throw new Error('SANDBOX_WEBHOOK_SECRET deve ter ao menos 32 caracteres.');
  const origin = new URL(env.APP_ORIGIN || 'http://127.0.0.1:3000');
  const database = env.DATABASE_PATH || './data/homologation.sqlite';
  mkdirSync(dirname(database), { recursive: true });
  return {
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 3000),
    origin: origin.origin, database, encryptionKey: env.DATA_ENCRYPTION_KEY,
    donationBeneficiary: env.DONATION_BENEFICIARY_NAME?.trim() || 'ORIN PAY YECNOLOGIA',
    webhookSecret: env.SANDBOX_WEBHOOK_SECRET, paymentsMode: env.PAYMENTS_MODE,
    bravoPay: {
      baseUrl: env.BRAVOPAY_BASE_URL, publicKey: env.BRAVOPAY_PUBLIC_KEY,
      secretKey: env.BRAVOPAY_SECRET_KEY, webhookSecret: env.BRAVOPAY_WEBHOOK_SECRET
    }
  };
}
