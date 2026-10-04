import { createCipheriv, createHash, randomBytes, createDecipheriv } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function normalizeCpf(value) {
  if (typeof value !== 'string' || !/^[\d.-]{11,14}$/.test(value)) throw new HttpError(400, 'Informe um CPF válido.');
  const cpf = value.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) throw new HttpError(400, 'Informe um CPF válido.');
  for (const length of [9, 10]) {
    const sum = [...cpf.slice(0, length)].reduce((total, digit, i) => total + Number(digit) * (length + 1 - i), 0);
    const digit = (sum * 10 % 11) % 10;
    if (digit !== Number(cpf[length])) throw new HttpError(400, 'Informe um CPF válido.');
  }
  return cpf;
}

export const hash = value => createHash('sha256').update(value).digest('hex');

export function encrypt(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') });
}

export function decrypt(value, key, context) {
  const envelope = JSON.parse(value);
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(envelope.iv, 'hex'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'hex')), cipher.final()]).toString('utf8'));
}

export function ownerFromRequest(req) {
  const token = req.headers.authorization?.match(/^Bearer ([a-f\d]{64})$/i)?.[1];
  if (!token) throw new HttpError(401, 'Sessão ausente ou inválida.');
  return hash(token);
}
