import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('CONSULTA','ABERTURA')),
      amount INTEGER NOT NULL CHECK(amount IN (3000,5000)),
      sensitive TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','FAILED','REFUNDED')),
      created TEXT NOT NULL, UNIQUE(owner,idem)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY, service_id TEXT NOT NULL UNIQUE REFERENCES services(id),
      status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','FAILED','REFUNDED'))
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, received TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      service_id TEXT PRIMARY KEY REFERENCES services(id), sensitive TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT REFERENCES services(id),
      action TEXT NOT NULL, created TEXT NOT NULL
    );`);
  const columns = new Set(db.prepare('PRAGMA table_info(payments)').all().map(column => column.name));
  transaction(db, () => {
    const additions = {
      provider: "TEXT NOT NULL DEFAULT 'SANDBOX' CHECK(provider IN ('SANDBOX','BRAVOPAY'))",
      provider_payment_id: 'TEXT', amount_cents: 'INTEGER', created_at: 'TEXT',
      payment_state: "TEXT CHECK(payment_state IN ('PENDING','PAID','FAILED','EXPIRED','REFUNDED'))",
      provider_status: 'TEXT', idempotency_key: 'TEXT',
      operation_state: "TEXT CHECK(operation_state IN ('SUBMITTING','CONFIRMED','REJECTED'))", instructions: 'TEXT'
    };
    for (const [name, definition] of Object.entries(additions)) if (!columns.has(name)) db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_id ON payments(provider,provider_payment_id);
      UPDATE payments SET provider_payment_id=id, amount_cents=(SELECT amount FROM services WHERE services.id=payments.service_id),
      created_at=(SELECT created FROM services WHERE services.id=payments.service_id) WHERE provider='SANDBOX' AND provider_payment_id IS NULL;
      PRAGMA user_version=2;`);
  });
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function audit(db, serviceId, action) {
  db.prepare('INSERT INTO audit(service_id,action,created) VALUES(?,?,?)').run(serviceId, action, new Date().toISOString());
}
