// Test helpers: a throwaway database per test file, and a signer standing in for magiclink.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_URL = process.env.SH_TEST_PG || 'postgres://postgres@localhost:54329/postgres';

export async function pgAvailable() {
  const c = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 1500 });
  try { await c.connect(); await c.end(); return true; } catch { return false; }
}

// Creates a database, returns { pool, url, drop }.
export async function freshDb(name) {
  const dbName = `shtest_${name}_${process.pid}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    pool, url,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}

export function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function sign(privatePem, claims, header = { alg: 'RS256', typ: 'JWT' }) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b(header)}.${b(claims)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), privatePem).toString('base64url');
  return `${input}.${sig}`;
}

export const nowS = () => Math.floor(Date.now() / 1000);

export function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
