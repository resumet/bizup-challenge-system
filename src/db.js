'use strict';
// Postgres 데이터 계층.
// - DATABASE_URL 이 있으면 node-postgres로 접속 (Supabase: Transaction pooler 6543 포트 권장)
// - 없으면 PGlite(WASM Postgres)를 사용 (로컬 개발·테스트용, DATA_DIR/pgdata 또는 메모리)
// SQL은 '?' 자리표시자로 작성하고 여기서 $1, $2…로 변환한다.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SCHEMA_FILE = path.join(__dirname, '..', 'supabase', 'migrations', '20261119000000_init.sql');
const als = new AsyncLocalStorage();

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

let driverPromise = null;
function createDriver() {
  const url = process.env.DATABASE_URL;
  if (url && !url.startsWith('pglite:')) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 (COUNT)
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric (SUM)
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || (process.env.VERCEL ? 3 : 10)),
      ssl: local || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      idleTimeoutMillis: 10000,
    });
    pool.on('error', (e) => console.error('pg pool error', e.message));
    return Promise.resolve({
      kind: 'pg',
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      exec: (sql) => pool.query(sql),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
          await client.query('COMMIT');
          return r;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
          throw e;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    });
  }
  if (process.env.VERCEL) {
    return Promise.reject(new Error('DATABASE_URL 환경변수가 설정되지 않았습니다. Vercel 프로젝트 설정에 Supabase 접속 문자열을 등록해주세요.'));
  }
  return (async () => {
    const { PGlite, types } = require('@electric-sql/pglite');
    let dataDir;
    if (url && url.startsWith('pglite:')) dataDir = url.slice('pglite:'.length) || undefined; // 'pglite:' = 메모리
    else { dataDir = path.join(DATA_DIR, 'pgdata'); fs.mkdirSync(DATA_DIR, { recursive: true }); }
    const db = new PGlite(dataDir, { parsers: { [types.INT8]: Number, [types.NUMERIC]: Number } });
    await db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8')); // 로컬은 시작 시 스키마 자동 적용
    return {
      kind: 'pglite',
      query: async (sql, params) => (await db.query(sql, params)).rows,
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows })),
      close: () => db.close(),
    };
  })();
}
function driver() {
  if (!driverPromise) driverPromise = createDriver();
  return driverPromise;
}

async function query(sql, params) {
  const t = als.getStore();
  if (t) return t.query(toPg(sql), params.map(norm));
  return (await driver()).query(toPg(sql), params.map(norm));
}
const get = async (sql, ...p) => (await query(sql, p))[0];
const all = (sql, ...p) => query(sql, p);
const run = async (sql, ...p) => { await query(sql, p); };

// 트랜잭션: 콜백 안의 get/all/run은 같은 연결을 사용한다. 중첩 호출은 바깥 트랜잭션에 합류한다.
async function tx(fn) {
  if (als.getStore()) return fn();
  const d = await driver();
  return d.transaction((t) => als.run(t, fn));
}

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// 표시번호 발급: CRS-000001 등. 원자적 증가, 재사용하지 않는다.
async function nextCode(prefix) {
  const r = await get(`INSERT INTO sequences(name, value) VALUES(?, 1)
    ON CONFLICT(name) DO UPDATE SET value = sequences.value + 1 RETURNING value`, prefix);
  return `${prefix}-${String(r.value).padStart(6, '0')}`;
}

async function migrate() {
  const d = await driver();
  if (d.kind === 'pg') await d.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}
async function close() {
  if (!driverPromise) return;
  const d = await driverPromise;
  driverPromise = null;
  await d.close();
}

module.exports = { get, all, run, tx, uuid, now, nextCode, migrate, close, driver, DATA_DIR };
