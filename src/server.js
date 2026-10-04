import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { paymentProvider } from './paymentProvider.js';
import { Services, PRICES } from './services.js';
import { HttpError, ownerFromRequest } from './security.js';

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, 'Requisição muito grande.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

export function createApp(config) {
  // Valida a seleção antes de criar/abrir o banco. Não há fallback entre modos.
  if (config.paymentsMode !== 'SANDBOX') paymentProvider(config);
  const db = openDatabase(config.database);
  const services = new Services(db, paymentProvider(config, db), config);
  const limits = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, config.origin).pathname;
      if (path.startsWith('/api/')) {
        const now = Date.now();
        for (const [key, value] of limits) if (value.until < now) limits.delete(key);
        const key = `${path.startsWith('/api/webhooks/') ? 'webhook' : 'application'}:${req.socket.remoteAddress}`;
        const limit = limits.get(key) || { count: 0, until: now + 60000 };
        limits.set(key, limit);
        if (++limit.count > 120) { res.setHeader('Retry-After', '60'); throw new HttpError(429, 'Aguarde um minuto e tente novamente.'); }
        if (req.headers.origin && req.headers.origin !== config.origin) throw new HttpError(403, 'Origem não permitida.');
      }
      if (req.method === 'GET' && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        res.writeHead(200, { 'Content-Type': type });
        res.end(readFileSync(new URL(`../public/${file}`, import.meta.url))); return;
      }
      if (req.method === 'GET' && path === '/api/catalog') return json(200, { environment: 'HOMOLOGATION', paymentsMode: config.paymentsMode, prices: PRICES });
      if (req.method === 'GET' && path === '/api/health') return json(200, { status: 'ok', environment: 'HOMOLOGATION' });
      if (req.method === 'POST' && (path === '/api/webhooks/payment' || (path === '/api/webhooks/sandbox' && config.paymentsMode === 'SANDBOX'))) {
        return json(200, services.webhook(await readBody(req), req.headers));
      }
      if (req.method === 'POST' && path === '/api/services') {
        const owner = ownerFromRequest(req);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
        let body;
        try { body = JSON.parse((await readBody(req)).toString('utf8')); }
        catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON inválido.'); }
        return json(201, await services.create(owner, req.headers['idempotency-key'], body));
      }
      const match = path.match(/^\/api\/services\/([a-f\d-]{36})$/i);
      if (req.method === 'GET' && match) return json(200, await services.refresh(ownerFromRequest(req), match[1]));
      throw new HttpError(404, 'Rota não encontrada.');
    } catch (error) {
      if (!(error instanceof HttpError)) process.stderr.write(`${JSON.stringify({ event: 'INTERNAL_ERROR', time: new Date().toISOString() })}\n`);
      if (!res.destroyed) json(error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Falha interna. Tente novamente.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('close', () => db.close());
  return { server, db };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const { server } = createApp(config);
    server.on('error', () => {
      process.stderr.write('Application server failed to listen.\n');
      server.close(); process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => process.stdout.write(`Homologação ${config.paymentsMode}: ${config.origin}\n`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close();
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
  } catch (error) {
    const messages = {
      BRAVOPAY_NOT_CONFIGURED: 'BravoPay provider is not configured.',
      INTEGRATION_PENDING: 'BravoPay provider implementation is pending.'
    };
    process.stderr.write(`${messages[error.code] || 'Application configuration is invalid.'}\n`);
    process.exitCode = 1;
  }
}
