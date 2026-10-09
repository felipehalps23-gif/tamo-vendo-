import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/database.js';

test('Migração v1→v2 preserva pagamento sandbox, constraints e conteúdo', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bp-migration-'));
  const path = join(directory, 'test.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`CREATE TABLE services (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('CONSULTA','ABERTURA')), amount INTEGER NOT NULL CHECK(amount IN (3000,5000)),
      sensitive TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','FAILED','REFUNDED')),
      created TEXT NOT NULL, UNIQUE(owner,idem));
      CREATE TABLE payments (id TEXT PRIMARY KEY, service_id TEXT NOT NULL UNIQUE REFERENCES services(id),
      status TEXT NOT NULL CHECK(status IN ('PENDING','PAID','FAILED','REFUNDED')));
      CREATE TABLE results (service_id TEXT PRIMARY KEY REFERENCES services(id), sensitive TEXT NOT NULL);
      CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT REFERENCES services(id), action TEXT NOT NULL, created TEXT NOT NULL);
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO services VALUES(?,?,?,?,?,?,?,?,?)').run('order_legacy', 'owner', 'idem', 'fingerprint', 'CONSULTA', 3000, 'original-encrypted-envelope', 'PAID', '2026-06-01T00:00:00Z');
    db.prepare('INSERT INTO payments VALUES(?,?,?)').run('sandbox_legacy', 'order_legacy', 'PAID');
    db.prepare('INSERT INTO results VALUES(?,?)').run('order_legacy', 'original-result');
    db.prepare('INSERT INTO audit(service_id,action,created) VALUES(?,?,?)').run('order_legacy', 'LEGACY', '2026-06-01T00:00:00Z');
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    const payment = db.prepare('SELECT * FROM payments').get();
    assert.equal(payment.status, 'PAID'); assert.equal(payment.provider, 'SANDBOX');
    assert.equal(payment.provider_payment_id, 'sandbox_legacy'); assert.equal(payment.amount_cents, 3000);
    assert.equal(payment.created_at, '2026-06-01T00:00:00Z');
    assert.equal(db.prepare('SELECT sensitive FROM services').get().sensitive, 'original-encrypted-envelope');
    assert.equal(db.prepare('SELECT sensitive FROM results').get().sensitive, 'original-result');
    assert.equal(db.prepare('SELECT action FROM audit').get().action, 'LEGACY');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.throws(() => db.prepare('INSERT INTO payments(id,service_id,status) VALUES(?,?,?)').run('duplicate', 'order_legacy', 'PENDING'));
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT count(*) AS n FROM payments').get().n, 1);
    assert.deepEqual(db.prepare('SELECT * FROM payments').get(), payment);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
