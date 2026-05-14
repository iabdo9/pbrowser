'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const OTPAuth = require('otpauth');

const {
  AUTH_USER,
  AUTH_PASS,
  TOTP_SECRET,
  SESSION_SECRET,
  PORT = 3000,
  DEFAULT_PG_URL = '',
} = process.env;

if (!AUTH_USER || !AUTH_PASS) {
  console.error('FATAL: AUTH_USER and AUTH_PASS must be set in .env');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));

app.use(session({
  name: 'pb.sid',
  secret: SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8 hours
  },
}));

// ---------- Auth helpers ----------
const totp = TOTP_SECRET
  ? new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(TOTP_SECRET.replace(/\s+/g, '')) })
  : null;

function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---------- Per-session Postgres pools ----------
const pools = new Map(); // sessionID -> { pool, info }

function getPool(req) {
  return pools.get(req.sessionID)?.pool || null;
}

async function destroyPool(sid) {
  const entry = pools.get(sid);
  if (entry) {
    pools.delete(sid);
    try { await entry.pool.end(); } catch (_) { }
  }
}

function requireDb(req, res, next) {
  if (!getPool(req)) return res.status(409).json({ error: 'not_connected' });
  next();
}

// ---------- Identifier quoting ----------
function qIdent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('invalid identifier');
  }
  return '"' + name.replace(/"/g, '""') + '"';
}

// ---------- Auth routes ----------
app.post('/api/login', async (req, res) => {
  const { username = '', password = '', totp: code = '' } = req.body || {};
  const userOk = safeEq(username, AUTH_USER);
  const passOk = safeEq(password, AUTH_PASS);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (totp) {
    const delta = totp.validate({ token: String(code).replace(/\s+/g, ''), window: 1 });
    if (delta === null) {
      return res.status(401).json({ error: 'invalid_totp' });
    }
  }
  req.session.user = AUTH_USER;
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  await destroyPool(req.sessionID);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({
    auth: !!(req.session && req.session.user),
    connected: !!getPool(req),
    totpRequired: !!totp,
    info: pools.get(req.sessionID)?.info || null,
    defaultPgUrl: DEFAULT_PG_URL || '',
  });
});

// ---------- Connection ----------
app.post('/api/connect', requireAuth, async (req, res) => {
  const { connectionString } = req.body || {};
  if (!connectionString || typeof connectionString !== 'string') {
    return res.status(400).json({ error: 'missing_connection_string' });
  }
  await destroyPool(req.sessionID);
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const r = await pool.query('SELECT current_database() AS db, current_user AS usr, version() AS version');
    const info = r.rows[0];
    pools.set(req.sessionID, { pool, info });
    res.json({ ok: true, info });
  } catch (e) {
    try { await pool.end(); } catch (_) { }
    res.status(400).json({ error: 'connect_failed', detail: e.message });
  }
});

app.post('/api/disconnect', requireAuth, async (req, res) => {
  await destroyPool(req.sessionID);
  res.json({ ok: true });
});

// ---------- Schema / metadata ----------
app.get('/api/schemas', requireAuth, requireDb, async (req, res) => {
  try {
    const r = await getPool(req).query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
        AND schema_name NOT LIKE 'pg_toast%'
        AND schema_name NOT LIKE 'pg_temp%'
      ORDER BY schema_name
    `);
    res.json({ schemas: r.rows.map(x => x.schema_name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tables', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  try {
    const r = await getPool(req).query(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `, [schema]);
    res.json({ tables: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/columns', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  const table = String(req.query.table || '');
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const cols = await getPool(req).query(`
      SELECT column_name, data_type, is_nullable, column_default, ordinal_position,
             udt_schema, udt_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schema, table]);
    const pk = await getPool(req).query(`
      SELECT a.attname AS column_name
      FROM   pg_index i
      JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE  i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary
    `, [schema, table]).catch(() => ({ rows: [] }));

    // Outgoing foreign keys: this table -> other tables
    const outFks = await getPool(req).query(`
      SELECT
        tc.constraint_name,
        kcu.column_name      AS column_name,
        kcu.ordinal_position AS pos,
        ccu.table_schema     AS ref_schema,
        ccu.table_name       AS ref_table,
        ccu.column_name      AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name   = $2
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `, [schema, table]).catch(() => ({ rows: [] }));

    // Incoming foreign keys: other tables -> this table
    const inFks = await getPool(req).query(`
      SELECT
        tc.constraint_name,
        tc.table_schema      AS schema,
        tc.table_name        AS table,
        kcu.column_name      AS column_name,
        kcu.ordinal_position AS pos,
        ccu.column_name      AS ref_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_schema = $1
        AND ccu.table_name   = $2
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position
    `, [schema, table]).catch(() => ({ rows: [] }));

    // Group by constraint name into composite FK objects
    function groupFks(rows, extra = () => ({})) {
      const map = new Map();
      for (const r of rows) {
        const key = r.constraint_name;
        if (!map.has(key)) map.set(key, { name: key, columns: [], refColumns: [], ...extra(r) });
        const g = map.get(key);
        g.columns.push(r.column_name);
        g.refColumns.push(r.ref_column);
      }
      return [...map.values()];
    }

    const outgoingFks = groupFks(outFks.rows, (r) => ({ refSchema: r.ref_schema, refTable: r.ref_table }));
    const incomingFks = groupFks(inFks.rows, (r) => ({ schema: r.schema, table: r.table }));

    // Unique constraints AND unique indexes on this table. Composite-aware.
    // Prisma's @@unique creates a unique index (not a table constraint), so we
    // must look at pg_index too — UNION'd with pg_constraint for explicit ones.
    const uniqRes = await getPool(req).query(`
      SELECT name, columns FROM (
        -- Explicit table constraints (PRIMARY KEY + UNIQUE)
        SELECT c.conname AS name,
               (
                 SELECT json_agg(a.attname ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
               ) AS columns
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE c.contype IN ('u','p')
          AND n.nspname = $1 AND t.relname = $2
        UNION ALL
        -- Unique indexes (covers Prisma @@unique etc.)
        SELECT ic.relname AS name,
               (
                 SELECT json_agg(a.attname ORDER BY k.ord)
                 FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                 WHERE k.attnum <> 0  -- skip expression columns
               ) AS columns
        FROM pg_index i
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class t  ON t.oid  = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE i.indisunique
          AND NOT i.indisprimary           -- already covered above
          AND i.indpred IS NULL            -- skip partial indexes (can't easily dedupe)
          AND NOT EXISTS (                 -- skip indexes backing a constraint (already covered)
            SELECT 1 FROM pg_constraint c2
            WHERE c2.conindid = i.indexrelid
          )
          AND n.nspname = $1 AND t.relname = $2
      ) u
      ORDER BY name
    `, [schema, table]).catch(() => ({ rows: [] }));
    // De-dupe by column set (just in case)
    const seenCols = new Set();
    const uniqueConstraints = [];
    for (const r of uniqRes.rows) {
      const cols = Array.isArray(r.columns) ? r.columns : [];
      if (cols.length === 0) continue;
      const key = cols.join('\0');
      if (seenCols.has(key)) continue;
      seenCols.add(key);
      uniqueConstraints.push({ name: r.name, columns: cols });
    }

    // Enum labels for any user-defined enum types referenced by columns.
    const enumPairs = [...new Set(
      cols.rows
        .filter(c => c.data_type === 'USER-DEFINED' && c.udt_schema && c.udt_name)
        .map(c => `${c.udt_schema}.${c.udt_name}`)
    )];
    const enums = {}; // "schema.name" -> [labels]
    if (enumPairs.length > 0) {
      const eRes = await getPool(req).query(`
        SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label, e.enumsortorder AS pos
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE (n.nspname || '.' || t.typname) = ANY($1)
        ORDER BY n.nspname, t.typname, e.enumsortorder
      `, [enumPairs]).catch(() => ({ rows: [] }));
      for (const r of eRes.rows) {
        const k = `${r.schema}.${r.name}`;
        (enums[k] = enums[k] || []).push(r.label);
      }
    }
    // Attach enum_values per column for client convenience.
    const columnsOut = cols.rows.map(c => {
      const key = c.udt_schema && c.udt_name ? `${c.udt_schema}.${c.udt_name}` : null;
      if (key && enums[key]) return { ...c, enum_values: enums[key] };
      return c;
    });

    res.json({
      columns: columnsOut,
      primaryKey: pk.rows.map(r => r.column_name),
      outgoingFks,
      incomingFks,
      uniqueConstraints,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Rows: list / paginate ----------
app.get('/api/rows', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  const table = String(req.query.table || '');
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const orderBy = req.query.orderBy ? String(req.query.orderBy) : null;
  const orderDir = String(req.query.orderDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    let sql = `SELECT * FROM ${fq}`;
    if (orderBy) sql += ` ORDER BY ${qIdent(orderBy)} ${orderDir}`;
    sql += ` LIMIT ${limit} OFFSET ${offset}`;
    const r = await getPool(req).query(sql);
    const countR = await getPool(req).query(`SELECT count(*)::bigint AS c FROM ${fq}`);
    res.json({
      rows: r.rows,
      fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      total: Number(countR.rows[0].c),
      limit, offset,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- FK reference values ----------
// Get distinct values from a referenced column. Used for FK validation in inserts.
// GET /api/fk-values?schema=&table=&column=&limit=&search=
app.get('/api/fk-values', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  const table = String(req.query.table || '');
  const column = String(req.query.column || '');
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const search = req.query.search ? String(req.query.search) : '';
  if (!table || !column) return res.status(400).json({ error: 'missing_fields' });
  try {
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    const col = qIdent(column);
    let sql, params;
    if (search) {
      sql = `SELECT DISTINCT ${col} AS v FROM ${fq} WHERE ${col}::text ILIKE $1 AND ${col} IS NOT NULL ORDER BY 1 LIMIT ${limit}`;
      params = [`%${search}%`];
    } else {
      sql = `SELECT DISTINCT ${col} AS v FROM ${fq} WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT ${limit}`;
      params = [];
    }
    const r = await getPool(req).query(sql, params);
    res.json({ values: r.rows.map(x => x.v) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Existing unique-tuple values ----------
// POST body: { schema, table, columns: [...], limit }
// Returns up to `limit` existing tuples to avoid collisions during bulk insert.
app.post('/api/unique-tuples', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, columns } = req.body || {};
  const limit = Math.min(parseInt(req.body?.limit, 10) || 10000, 100000);
  if (!table || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  try {
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    const colsSql = columns.map(qIdent).join(', ');
    const sql = `SELECT DISTINCT ${colsSql} FROM ${fq} LIMIT ${limit}`;
    const r = await getPool(req).query(sql);
    res.json({ rows: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Related rows (via FK) ----------
// Body: { schema, table, where: {col: val, ...}, limit, offset, countOnly }
app.post('/api/related', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, where, countOnly } = req.body || {};
  const limit = Math.min(parseInt(req.body?.limit, 10) || 25, 500);
  const offset = Math.max(parseInt(req.body?.offset, 10) || 0, 0);
  if (!table || !where || typeof where !== 'object') {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const keys = Object.keys(where);
  if (keys.length === 0) return res.status(400).json({ error: 'empty_where' });
  try {
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    const whereSql = keys.map((k, i) => {
      if (where[k] === null) return `${qIdent(k)} IS NULL`;
      return `${qIdent(k)} = $${i + 1}`;
    }).join(' AND ');
    const vals = keys.filter(k => where[k] !== null).map(k => where[k]);
    const countR = await getPool(req).query(`SELECT count(*)::bigint AS c FROM ${fq} WHERE ${whereSql}`, vals);
    const total = Number(countR.rows[0].c);
    if (countOnly) return res.json({ total });
    const r = await getPool(req).query(
      `SELECT * FROM ${fq} WHERE ${whereSql} LIMIT ${limit} OFFSET ${offset}`,
      vals,
    );
    res.json({
      rows: r.rows,
      fields: r.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      total, limit, offset,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- CRUD ----------
function buildWhereFromPk(pk) {
  const keys = Object.keys(pk || {});
  if (keys.length === 0) throw new Error('primary key required');
  const where = keys.map((k, i) => `${qIdent(k)} = $${i + 1}`).join(' AND ');
  const vals = keys.map(k => pk[k]);
  return { where, vals };
}

app.post('/api/insert', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, row } = req.body || {};
  if (!table || !row || typeof row !== 'object') {
    return res.status(400).json({ error: 'missing_table_or_row' });
  }
  const keys = Object.keys(row);
  if (keys.length === 0) return res.status(400).json({ error: 'empty_row' });
  try {
    const cols = keys.map(qIdent).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const vals = keys.map(k => row[k]);
    const sql = `INSERT INTO ${qIdent(schema)}.${qIdent(table)} (${cols}) VALUES (${placeholders}) RETURNING *`;
    const r = await getPool(req).query(sql, vals);
    res.json({ ok: true, row: r.rows[0] });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk insert. Body: { schema, table, rows: [{col:val,...},...] }
// Per-row, any column with value === undefined (or key omitted) becomes DEFAULT.
app.post('/api/insert-bulk', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, rows } = req.body || {};
  if (!table || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'missing_table_or_rows' });
  }
  if (rows.length > 100000) return res.status(400).json({ error: 'too_many_rows' });
  // Collect all column keys across the batch (stable order from first row, then any extras).
  const keySet = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') return res.status(400).json({ error: 'invalid_row' });
    for (const k of Object.keys(r)) keySet.add(k);
  }
  const keys = [...keySet];
  if (keys.length === 0) return res.status(400).json({ error: 'empty_row' });

  const client = await getPool(req).connect();
  try {
    await client.query('BEGIN');
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    const colsSql = keys.map(qIdent).join(', ');
    const BATCH = 200;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const valuesSql = [];
      const params = [];
      let p = 1;
      for (const row of slice) {
        const ph = keys.map(k => (row[k] === undefined ? 'DEFAULT' : `$${p++}`));
        valuesSql.push(`(${ph.join(', ')})`);
        for (const k of keys) if (row[k] !== undefined) params.push(row[k]);
      }
      const sql = `INSERT INTO ${fq} (${colsSql}) VALUES ${valuesSql.join(', ')}`;
      const r = await client.query(sql, params);
      inserted += r.rowCount;
    }
    await client.query('COMMIT');
    res.json({ ok: true, inserted });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/update', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, pk, row } = req.body || {};
  if (!table || !row || !pk) return res.status(400).json({ error: 'missing_fields' });
  const setKeys = Object.keys(row);
  if (setKeys.length === 0) return res.status(400).json({ error: 'empty_row' });
  try {
    const setClause = setKeys.map((k, i) => `${qIdent(k)} = $${i + 1}`).join(', ');
    const setVals = setKeys.map(k => row[k]);
    const { where, vals: pkVals } = buildWhereFromPk(pk);
    const shifted = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + setVals.length}`);
    const sql = `UPDATE ${qIdent(schema)}.${qIdent(table)} SET ${setClause} WHERE ${shifted} RETURNING *`;
    const r = await getPool(req).query(sql, [...setVals, ...pkVals]);
    res.json({ ok: true, row: r.rows[0] || null, affected: r.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/delete', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, pk } = req.body || {};
  if (!table || !pk) return res.status(400).json({ error: 'missing_fields' });
  try {
    const { where, vals } = buildWhereFromPk(pk);
    const sql = `DELETE FROM ${qIdent(schema)}.${qIdent(table)} WHERE ${where}`;
    const r = await getPool(req).query(sql, vals);
    res.json({ ok: true, affected: r.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Bulk delete. Body: { schema, table, pks: [{col:val,...}, ...] }
// All PKs must share the same key set (validated). One transactional DELETE per batch.
app.post('/api/delete-bulk', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, pks } = req.body || {};
  if (!table || !Array.isArray(pks) || pks.length === 0) {
    return res.status(400).json({ error: 'missing_table_or_pks' });
  }
  if (pks.length > 100000) return res.status(400).json({ error: 'too_many_rows' });
  const keys = Object.keys(pks[0] || {});
  if (keys.length === 0) return res.status(400).json({ error: 'empty_pk' });
  for (const p of pks) {
    if (!p || typeof p !== 'object') return res.status(400).json({ error: 'invalid_pk' });
    const k = Object.keys(p);
    if (k.length !== keys.length || !keys.every(x => x in p)) {
      return res.status(400).json({ error: 'inconsistent_pk_shape' });
    }
  }
  const client = await getPool(req).connect();
  try {
    await client.query('BEGIN');
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    const BATCH = 500;
    let affected = 0;
    if (keys.length === 1) {
      // Fast path: WHERE pk = ANY($1)
      const col = qIdent(keys[0]);
      for (let i = 0; i < pks.length; i += BATCH) {
        const slice = pks.slice(i, i + BATCH).map(p => p[keys[0]]);
        const r = await client.query(`DELETE FROM ${fq} WHERE ${col} = ANY($1)`, [slice]);
        affected += r.rowCount;
      }
    } else {
      // Composite PK: WHERE (a,b) IN (($1,$2), ($3,$4), ...)
      const colsSql = '(' + keys.map(qIdent).join(', ') + ')';
      for (let i = 0; i < pks.length; i += BATCH) {
        const slice = pks.slice(i, i + BATCH);
        const params = [];
        let p = 1;
        const tuples = slice.map(pk => {
          const ph = keys.map(() => `$${p++}`).join(', ');
          for (const k of keys) params.push(pk[k]);
          return `(${ph})`;
        });
        const r = await client.query(
          `DELETE FROM ${fq} WHERE ${colsSql} IN (${tuples.join(', ')})`,
          params,
        );
        affected += r.rowCount;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, affected });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});


// ---------- Raw SQL ----------
app.post('/api/query', requireAuth, requireDb, async (req, res) => {
  const { sql, params } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ error: 'missing_sql' });
  try {
    const r = await getPool(req).query(sql, Array.isArray(params) ? params : undefined);
    res.json({
      ok: true,
      command: r.command,
      rowCount: r.rowCount,
      rows: r.rows,
      fields: (r.fields || []).map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Static / pages ----------
app.use('/static', express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`pbrowser listening on http://localhost:${PORT}`);
  if (!totp) console.log('TOTP disabled (TOTP_SECRET not set)');
});
