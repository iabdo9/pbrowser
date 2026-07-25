'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
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

// ---------- Saved connections ----------
// Persisted to disk so the user can one-click reconnect without re-entering
// credentials. Holds DB passwords in plaintext (same posture as DEFAULT_PG_URL
// in .env), so the file is written 0600 and must stay gitignored. The full
// connection string is NEVER sent to the browser — only host/user/db metadata.
const CONNECTIONS_FILE = process.env.CONNECTIONS_FILE || path.join(__dirname, 'connections.json');

function loadConnections() {
  try {
    const arr = JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveConnections(list) {
  try {
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch (e) { console.error('Failed to persist connections:', e.message); }
}

// Derive non-secret display fields from a connection string (URL form).
function describeConn(cs) {
  try {
    const u = new URL(cs);
    return {
      host: u.hostname || '',
      port: u.port || '',
      db: decodeURIComponent((u.pathname || '').replace(/^\//, '')) || '',
      user: decodeURIComponent(u.username || '') || '',
    };
  } catch (_) {
    return { host: '', port: '', db: '', user: '' };
  }
}

// Client-safe projection: everything except the connection string (secret).
function publicConn(c) {
  return {
    id: c.id, label: c.label, host: c.host, port: c.port,
    db: c.db, user: c.user, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt,
  };
}

// Remember a successfully-used connection string (dedupe by exact string).
function rememberConnection(cs, label) {
  const list = loadConnections();
  const now = new Date().toISOString();
  const desc = describeConn(cs);
  const existing = list.find(c => c.connectionString === cs);
  if (existing) {
    Object.assign(existing, desc, { lastUsedAt: now });
    if (label) existing.label = String(label).slice(0, 100);
  } else {
    list.push({
      id: crypto.randomBytes(9).toString('hex'),
      label: (label && String(label).slice(0, 100))
        || (desc.user && desc.host ? `${desc.user}@${desc.host}${desc.db ? '/' + desc.db : ''}` : (desc.db || 'connection')),
      connectionString: cs,
      ...desc,
      createdAt: now,
      lastUsedAt: now,
    });
  }
  saveConnections(list);
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
  let { connectionString, id, label } = req.body || {};
  // Reconnect to a saved connection by id (the browser never holds the secret).
  if (id) {
    const saved = loadConnections().find(c => c.id === id);
    if (!saved) return res.status(404).json({ error: 'unknown_connection' });
    connectionString = saved.connectionString;
  }
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
    // Retain the connection string so pg_dump / pg_restore / psql can reconnect
    // for full-database export & import (kept in memory only, per session).
    pools.set(req.sessionID, { pool, info, connectionString });
    try { rememberConnection(connectionString, label); } catch (_) { /* non-fatal */ }
    res.json({ ok: true, info });
  } catch (e) {
    try { await pool.end(); } catch (_) { }
    res.status(400).json({ error: 'connect_failed', detail: e.message });
  }
});

// ---------- Saved connections CRUD (metadata only; secrets stay server-side) ----------
app.get('/api/connections', requireAuth, (req, res) => {
  const list = loadConnections()
    .sort((a, b) => String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  res.json({ connections: list.map(publicConn) });
});

app.patch('/api/connections/:id', requireAuth, (req, res) => {
  const { label } = req.body || {};
  const list = loadConnections();
  const c = list.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'unknown_connection' });
  if (typeof label === 'string' && label.trim()) c.label = label.trim().slice(0, 100);
  saveConnections(list);
  res.json({ ok: true, connection: publicConn(c) });
});

app.delete('/api/connections/:id', requireAuth, (req, res) => {
  const list = loadConnections();
  const idx = list.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'unknown_connection' });
  list.splice(idx, 1);
  saveConnections(list);
  res.json({ ok: true });
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

// ---------- Schema map: all tables + columns + FKs in a schema ----------
app.get('/api/schema-map', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  try {
    const pool = getPool(req);
    const tablesRes = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type IN ('BASE TABLE','VIEW')
      ORDER BY table_name
    `, [schema]);
    const tableNames = tablesRes.rows.map(r => r.table_name);

    const colsRes = await pool.query(`
      SELECT table_name, column_name, data_type, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position
    `, [schema]);

    const pksRes = await pool.query(`
      SELECT t.relname AS table_name, a.attname AS column_name
      FROM pg_index i
      JOIN pg_class t      ON t.oid = i.indrelid
      JOIN pg_namespace n  ON n.oid = t.relnamespace
      JOIN pg_attribute a  ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary AND n.nspname = $1
    `, [schema]);

    const fksRes = await pool.query(`
      SELECT
        tc.constraint_name,
        tc.table_name        AS from_table,
        kcu.column_name      AS from_column,
        kcu.ordinal_position AS pos,
        ccu.table_schema     AS to_schema,
        ccu.table_name       AS to_table,
        ccu.column_name      AS to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema    = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
      ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
    `, [schema]);

    // Build tables list with columns + pks
    const colsByTable = new Map();
    for (const r of colsRes.rows) {
      if (!colsByTable.has(r.table_name)) colsByTable.set(r.table_name, []);
      colsByTable.get(r.table_name).push({ name: r.column_name, type: r.data_type });
    }
    const pksByTable = new Map();
    for (const r of pksRes.rows) {
      if (!pksByTable.has(r.table_name)) pksByTable.set(r.table_name, new Set());
      pksByTable.get(r.table_name).add(r.column_name);
    }
    const tables = tableNames.map(name => ({
      name,
      columns: colsByTable.get(name) || [],
      primaryKey: [...(pksByTable.get(name) || [])],
    }));

    // Group FK rows into composite-aware edges
    const edgeMap = new Map();
    for (const r of fksRes.rows) {
      const key = `${r.from_table}::${r.constraint_name}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          name: r.constraint_name,
          fromTable: r.from_table,
          fromColumns: [],
          toSchema: r.to_schema,
          toTable: r.to_table,
          toColumns: [],
        });
      }
      const e = edgeMap.get(key);
      e.fromColumns.push(r.from_column);
      e.toColumns.push(r.to_column);
    }
    const edges = [...edgeMap.values()];

    res.json({ schema, tables, edges });
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

// ---------- Bulk fetch for export ----------
// Returns all rows for a selection (by primary keys) or for the current filter,
// in one query, capped at EXPORT_MAX_ROWS. Formatting into CSV/JSON happens on the
// client from the data it already renders; this only supplies rows it doesn't have
// (selections spanning pages, or the full result set beyond the current page).
const EXPORT_MAX_ROWS = Number(process.env.EXPORT_MAX_ROWS || 200000);
app.post('/api/export-rows', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, orderBy, orderDir, where, pks } = req.body || {};
  if (!table) return res.status(400).json({ error: 'missing_table' });
  const limit = Math.min(parseInt(req.body?.limit, 10) || EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  try {
    const fq = `${qIdent(schema)}.${qIdent(table)}`;
    let whereSql = '';
    const vals = [];
    if (Array.isArray(pks) && pks.length > 0) {
      const keys = Object.keys(pks[0] || {});
      if (keys.length === 0) return res.status(400).json({ error: 'empty_pk' });
      if (keys.length === 1) {
        // Single-column PK: one array parameter handles any number of keys.
        whereSql = `WHERE ${qIdent(keys[0])} = ANY($1)`;
        vals.push(pks.map(p => p[keys[0]]));
      } else {
        // Composite PK: OR of AND-groups. Guard against the bind-parameter limit.
        if (pks.length * keys.length > 60000) {
          return res.status(400).json({ error: 'selection_too_large', detail: 'Too many selected rows with a composite key; export by filter instead.' });
        }
        let pi = 1;
        const groups = pks.map(p => `(${keys.map(k => `${qIdent(k)} = $${pi++}`).join(' AND ')})`);
        for (const p of pks) for (const k of keys) vals.push(p[k]);
        whereSql = `WHERE ${groups.join(' OR ')}`;
      }
    } else if (where && typeof where === 'object' && Object.keys(where).length > 0) {
      const keys = Object.keys(where);
      whereSql = 'WHERE ' + keys.map((k, i) => where[k] === null ? `${qIdent(k)} IS NULL` : `${qIdent(k)} = $${i + 1}`).join(' AND ');
      for (const k of keys) if (where[k] !== null) vals.push(where[k]);
    }
    let sql = `SELECT * FROM ${fq} ${whereSql}`;
    if (orderBy) sql += ` ORDER BY ${qIdent(orderBy)} ${String(orderDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`;
    sql += ` LIMIT ${limit + 1}`; // +1 row to detect truncation
    const r = await getPool(req).query(sql, vals);
    const truncated = r.rows.length > limit;
    res.json({
      rows: truncated ? r.rows.slice(0, limit) : r.rows,
      fields: r.fields.map(f => ({ name: f.name })),
      truncated,
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

// ---------- Schema management (DDL) ----------
// Identifiers and type names cannot be bound as query parameters, so both are
// validated and quoted here. This group grants no privilege that /api/query does
// not already grant an authenticated user; validation keeps the API predictable
// and prevents a single field from turning into multiple statements.

// serial/bigserial are pseudo-types: legal in CREATE TABLE / ADD COLUMN but
// unknown to to_regtype(), so they are allowed explicitly.
const SERIAL_TYPES = new Set(['serial', 'serial2', 'serial4', 'serial8', 'smallserial', 'bigserial']);
const INDEX_METHODS = new Set(['btree', 'hash', 'gist', 'gin', 'spgist', 'brin']);
const TYPE_RE = /^[A-Za-z0-9_\s,()[\]."]+$/;

async function validType(pool, type) {
  const t = String(type || '').trim();
  if (!t || t.length > 200 || !TYPE_RE.test(t)) throw new Error('invalid type');
  if (SERIAL_TYPES.has(t.toLowerCase())) return t;
  let ok = false;
  try {
    const r = await pool.query('SELECT to_regtype($1) AS t', [t]);
    ok = !!(r.rows[0] && r.rows[0].t !== null);
  } catch (_) { ok = false; }
  if (!ok) throw new Error(`unknown type: ${t}`);
  return t;
}

// DEFAULT bodies are raw SQL expressions; reject statement separators.
function validExpr(e) {
  const s = String(e == null ? '' : e).trim();
  if (s === '') return '';
  if (s.length > 500 || s.includes(';')) throw new Error('invalid default expression');
  return s;
}

function fqTable(schema, table) {
  return `${qIdent(schema || 'public')}.${qIdent(table)}`;
}

app.get('/api/indexes', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  const table = String(req.query.table || '');
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const r = await getPool(req).query(`
      SELECT i.relname AS name,
             ix.indisunique  AS is_unique,
             ix.indisprimary AS is_primary,
             am.amname       AS method,
             pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class i     ON i.oid = ix.indexrelid
      JOIN pg_class t     ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am       ON am.oid = i.relam
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY ix.indisprimary DESC, i.relname
    `, [schema, table]);
    res.json({ indexes: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/constraints', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  const table = String(req.query.table || '');
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const r = await getPool(req).query(`
      SELECT con.conname AS name,
             con.contype AS type,
             pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel   ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = $1 AND rel.relname = $2
      ORDER BY con.contype, con.conname
    `, [schema, table]);
    res.json({ constraints: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Tables -----
app.post('/api/ddl/table/create', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, columns } = req.body || {};
  if (!table || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'missing_table_or_columns' });
  }
  try {
    const pool = getPool(req);
    const defs = [], pks = [];
    for (const c of columns) {
      if (!c || !c.name) throw new Error('every column needs a name');
      const type = await validType(pool, c.type);
      let d = `${qIdent(c.name)} ${type}`;
      if (c.notNull) d += ' NOT NULL';
      const dv = validExpr(c.default);
      if (dv) d += ` DEFAULT ${dv}`;
      defs.push(d);
      if (c.primaryKey) pks.push(qIdent(c.name));
    }
    if (pks.length) defs.push(`PRIMARY KEY (${pks.join(', ')})`);
    const sql = `CREATE TABLE ${fqTable(schema, table)} (\n  ${defs.join(',\n  ')}\n)`;
    await pool.query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/table/rename', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, newName } = req.body || {};
  if (!table || !newName) return res.status(400).json({ error: 'missing_fields' });
  try {
    const sql = `ALTER TABLE ${fqTable(schema, table)} RENAME TO ${qIdent(newName)}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/table/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, cascade } = req.body || {};
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const sql = `DROP TABLE ${fqTable(schema, table)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/table/truncate', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, cascade, restartIdentity } = req.body || {};
  if (!table) return res.status(400).json({ error: 'missing_table' });
  try {
    const sql = `TRUNCATE ${fqTable(schema, table)}`
      + (restartIdentity ? ' RESTART IDENTITY' : '')
      + (cascade ? ' CASCADE' : '');
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Physically rebuild a table with its columns in a new order. Postgres cannot
// reorder columns in place (attnum is fixed), so the only real way is to create a
// new table, copy the rows, drop the original and rename. Everything runs inside a
// single transaction: Postgres has transactional DDL, so any failure rolls the
// whole thing back and the original table is untouched.
//
// Preserved: types, NOT NULL, defaults, identity/serial sequences (and their
// current values), PK/unique/check/FK constraints, incoming FKs from other
// tables, indexes, and triggers.
// NOT preserved: grants/ACLs, RLS policies, comments. Dependent views,
// inheritance and partitioning are refused up front rather than silently lost.
app.post('/api/ddl/table/rebuild', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, columns } = req.body || {};
  if (!table || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'missing_table_or_columns' });
  }
  const pool = getPool(req);
  const client = await pool.connect();
  const executed = [];
  const run = async (sql) => { executed.push(sql); await client.query(sql); };
  try {
    const rel = await client.query(
      `SELECT c.oid, c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`, [schema, table]);
    if (rel.rowCount === 0) throw new Error('table not found');
    const oid = rel.rows[0].oid;
    if (rel.rows[0].relkind !== 'r') throw new Error('only ordinary tables can be rebuilt');

    const inh = await client.query('SELECT 1 FROM pg_inherits WHERE inhrelid = $1 OR inhparent = $1 LIMIT 1', [oid]);
    if (inh.rowCount) throw new Error('table uses inheritance or partitioning — rebuild is not supported');

    const deps = await client.query(`
      SELECT DISTINCT dn.nspname AS schema, dv.relname AS name
      FROM pg_depend d
      JOIN pg_rewrite r    ON d.objid = r.oid
      JOIN pg_class dv     ON r.ev_class = dv.oid
      JOIN pg_namespace dn ON dn.oid = dv.relnamespace
      WHERE d.refobjid = $1 AND dv.oid <> $1 AND dv.relkind IN ('v','m')
    `, [oid]);
    if (deps.rowCount) {
      throw new Error('these views depend on the table and would be destroyed — drop them first: '
        + deps.rows.map(d => `${d.schema}.${d.name}`).join(', '));
    }

    const colsR = await client.query(`
      SELECT a.attname AS name,
             format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS notnull,
             pg_get_expr(d.adbin, d.adrelid) AS def,
             a.attidentity AS identity,
             a.attgenerated AS generated
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [oid]);
    const byName = new Map(colsR.rows.map(c => [c.name, c]));
    const have = [...byName.keys()].sort();
    const want = [...columns].sort();
    if (have.length !== want.length || have.some((n, i) => n !== want[i])) {
      throw new Error('column list must be a permutation of the existing columns');
    }
    const ordered = columns.map(n => byName.get(n));

    const cons = await client.query(`
      SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = $1
      ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname
    `, [oid]);
    const inFks = await client.query(`
      SELECT n.nspname AS schema, cl.relname AS table, con.conname AS name,
             pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class cl     ON cl.oid = con.conrelid
      JOIN pg_namespace n  ON n.oid = cl.relnamespace
      WHERE con.confrelid = $1 AND con.contype = 'f'
    `, [oid]);
    const idxs = await client.query(`
      SELECT i.relname AS name, pg_get_indexdef(ix.indexrelid) AS def
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE ix.indrelid = $1
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid)
    `, [oid]);
    const trigs = await client.query(
      'SELECT tgname AS name, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal', [oid]);
    const seqs = await client.query(`
      SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname) AS seq, a.attname AS col
      FROM pg_depend d
      JOIN pg_class s      ON s.oid = d.objid AND s.relkind = 'S'
      JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_attribute a  ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE d.refobjid = $1 AND d.deptype = 'a' AND d.classid = 'pg_class'::regclass
    `, [oid]);

    // Identity columns get a brand-new sequence in the new table, so capture the
    // current value to restore afterwards. Plain serial columns keep their own
    // sequence, which is detached below so DROP TABLE cannot take it with them.
    const identityState = [];
    for (const s of seqs.rows) {
      const c = byName.get(s.col);
      if (c && (c.identity === 'a' || c.identity === 'd')) {
        const v = await client.query(`SELECT last_value, is_called FROM ${s.seq}`);
        identityState.push({ col: s.col, last: v.rows[0].last_value, called: v.rows[0].is_called });
      }
    }
    const serialSeqs = seqs.rows.filter(s => {
      const c = byName.get(s.col);
      return c && c.identity !== 'a' && c.identity !== 'd';
    });

    const colDef = (c) => {
      let d = `${qIdent(c.name)} ${c.type}`;
      if (c.generated === 's') d += ` GENERATED ALWAYS AS (${c.def}) STORED`;
      else if (c.identity === 'a' || c.identity === 'd') d += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      else if (c.def != null) d += ` DEFAULT ${c.def}`;
      if (c.notnull) d += ' NOT NULL';
      return d;
    };

    const fq = fqTable(schema, table);
    const tmpName = `${table}__pb_rebuild`;
    const tmpFq = fqTable(schema, tmpName);
    const copyCols = ordered.filter(c => c.generated !== 's');
    const colList = copyCols.map(c => qIdent(c.name)).join(', ');
    const overriding = ordered.some(c => c.identity === 'a') ? ' OVERRIDING SYSTEM VALUE' : '';

    await client.query('BEGIN');
    for (const s of serialSeqs) await run(`ALTER SEQUENCE ${s.seq} OWNED BY NONE`);
    await run(`CREATE TABLE ${tmpFq} (\n  ${ordered.map(colDef).join(',\n  ')}\n)`);
    await run(`INSERT INTO ${tmpFq} (${colList})${overriding} SELECT ${colList} FROM ${fq}`);
    await run(`DROP TABLE ${fq} CASCADE`);
    await run(`ALTER TABLE ${tmpFq} RENAME TO ${qIdent(table)}`);
    for (const c of cons.rows) await run(`ALTER TABLE ${fq} ADD CONSTRAINT ${qIdent(c.name)} ${c.def}`);
    for (const i of idxs.rows) await run(i.def);
    for (const t of trigs.rows) await run(t.def);
    for (const f of inFks.rows) {
      await run(`ALTER TABLE ${fqTable(f.schema, f.table)} ADD CONSTRAINT ${qIdent(f.name)} ${f.def}`);
    }
    for (const s of serialSeqs) await run(`ALTER SEQUENCE ${s.seq} OWNED BY ${fq}.${qIdent(s.col)}`);
    for (const st of identityState) {
      const r = await client.query('SELECT pg_get_serial_sequence($1, $2) AS s', [`${schema}.${table}`, st.col]);
      if (r.rows[0] && r.rows[0].s) {
        await client.query('SELECT setval($1, $2, $3)', [r.rows[0].s, st.last, st.called]);
        executed.push(`SELECT setval('${r.rows[0].s}', ${st.last}, ${st.called})`);
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, sql: executed.join(';\n') });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// ----- Columns -----
app.post('/api/ddl/column/add', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, name, type, notNull, default: def } = req.body || {};
  if (!table || !name || !type) return res.status(400).json({ error: 'missing_fields' });
  try {
    const pool = getPool(req);
    const t = await validType(pool, type);
    const dv = validExpr(def);
    const sql = `ALTER TABLE ${fqTable(schema, table)} ADD COLUMN ${qIdent(name)} ${t}`
      + (notNull ? ' NOT NULL' : '') + (dv ? ` DEFAULT ${dv}` : '');
    await pool.query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Applies any subset of {type, notNull, default, rename}. Runs in one transaction;
// the rename goes last so the other clauses still address the original name.
app.post('/api/ddl/column/alter', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, column, newName, type, notNull, default: def, dropDefault } = req.body || {};
  if (!table || !column) return res.status(400).json({ error: 'missing_fields' });
  const pool = getPool(req);
  const client = await pool.connect();
  const run = [];
  try {
    const fq = fqTable(schema, table);
    if (type) {
      const t = await validType(pool, type);
      run.push(`ALTER TABLE ${fq} ALTER COLUMN ${qIdent(column)} TYPE ${t} USING ${qIdent(column)}::${t}`);
    }
    if (typeof notNull === 'boolean') {
      run.push(`ALTER TABLE ${fq} ALTER COLUMN ${qIdent(column)} ${notNull ? 'SET' : 'DROP'} NOT NULL`);
    }
    if (dropDefault) {
      run.push(`ALTER TABLE ${fq} ALTER COLUMN ${qIdent(column)} DROP DEFAULT`);
    } else {
      const dv = validExpr(def);
      if (dv) run.push(`ALTER TABLE ${fq} ALTER COLUMN ${qIdent(column)} SET DEFAULT ${dv}`);
    }
    if (newName && newName !== column) {
      run.push(`ALTER TABLE ${fq} RENAME COLUMN ${qIdent(column)} TO ${qIdent(newName)}`);
    }
    if (run.length === 0) return res.status(400).json({ error: 'nothing_to_change' });
    await client.query('BEGIN');
    for (const s of run) await client.query(s);
    await client.query('COMMIT');
    res.json({ ok: true, sql: run.join(';\n') });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

app.post('/api/ddl/column/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, column, cascade } = req.body || {};
  if (!table || !column) return res.status(400).json({ error: 'missing_fields' });
  try {
    const sql = `ALTER TABLE ${fqTable(schema, table)} DROP COLUMN ${qIdent(column)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Indexes -----
app.post('/api/ddl/index/create', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, name, columns, unique, method = 'btree' } = req.body || {};
  if (!table || !name || !Array.isArray(columns) || columns.length === 0) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const m = String(method).toLowerCase();
  if (!INDEX_METHODS.has(m)) return res.status(400).json({ error: 'invalid_index_method' });
  try {
    const cols = columns.map(qIdent).join(', ');
    const sql = `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${qIdent(name)} ON ${fqTable(schema, table)} USING ${m} (${cols})`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/index/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', name, cascade } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `DROP INDEX ${qIdent(schema)}.${qIdent(name)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Constraints -----
app.post('/api/ddl/constraint/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', table, name, cascade } = req.body || {};
  if (!table || !name) return res.status(400).json({ error: 'missing_fields' });
  try {
    const sql = `ALTER TABLE ${fqTable(schema, table)} DROP CONSTRAINT ${qIdent(name)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Constraint creation -----
const REF_ACTIONS = new Set(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']);
function refAction(a) {
  const s = String(a || 'NO ACTION').toUpperCase().trim();
  if (!REF_ACTIONS.has(s)) throw new Error('invalid referential action');
  return s;
}
// Produce a properly escaped SQL string literal using the server's own quoting.
async function sqlLiteral(pool, s) {
  const r = await pool.query('SELECT quote_literal($1::text) AS l', [String(s)]);
  return r.rows[0].l;
}
// A SQL body (view SELECT, function definition). Trailing semicolons are stripped;
// interior ones are rejected so one field cannot become several statements.
function validBody(sql, { allowSemicolons = false, max = 200000 } = {}) {
  let s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('SQL body is required');
  if (s.length > max) throw new Error('SQL body too long');
  if (!allowSemicolons && s.includes(';')) throw new Error('SQL body must be a single statement');
  return s;
}

app.post('/api/ddl/constraint/add', requireAuth, requireDb, async (req, res) => {
  const {
    schema = 'public', table, name, type, columns, expression,
    refSchema, refTable, refColumns, onDelete, onUpdate,
  } = req.body || {};
  if (!table || !name || !type) return res.status(400).json({ error: 'missing_fields' });
  try {
    const fq = fqTable(schema, table);
    const cols = () => {
      if (!Array.isArray(columns) || columns.length === 0) throw new Error('select at least one column');
      return columns.map(qIdent).join(', ');
    };
    let clause;
    switch (String(type).toLowerCase()) {
      case 'unique': clause = `UNIQUE (${cols()})`; break;
      case 'pk': case 'primary': clause = `PRIMARY KEY (${cols()})`; break;
      case 'check': {
        const e = validExpr(expression);
        if (!e) throw new Error('check expression is required');
        clause = `CHECK (${e})`;
        break;
      }
      case 'fk': case 'foreign': {
        if (!refTable) throw new Error('referenced table is required');
        if (!Array.isArray(refColumns) || refColumns.length === 0) throw new Error('referenced column is required');
        clause = `FOREIGN KEY (${cols()}) REFERENCES ${fqTable(refSchema || schema, refTable)}`
          + ` (${refColumns.map(qIdent).join(', ')})`
          + ` ON DELETE ${refAction(onDelete)} ON UPDATE ${refAction(onUpdate)}`;
        break;
      }
      default: throw new Error('unknown constraint type');
    }
    const sql = `ALTER TABLE ${fq} ADD CONSTRAINT ${qIdent(name)} ${clause}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Database objects: schemas, views, functions, roles ----------
app.get('/api/db/schemas', requireAuth, requireDb, async (req, res) => {
  try {
    const r = await getPool(req).query(`
      SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner
      FROM pg_namespace n
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname
    `);
    res.json({ schemas: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/schema/create', requireAuth, requireDb, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `CREATE SCHEMA ${qIdent(name)}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/schema/rename', requireAuth, requireDb, async (req, res) => {
  const { name, newName } = req.body || {};
  if (!name || !newName) return res.status(400).json({ error: 'missing_fields' });
  try {
    const sql = `ALTER SCHEMA ${qIdent(name)} RENAME TO ${qIdent(newName)}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/schema/drop', requireAuth, requireDb, async (req, res) => {
  const { name, cascade } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `DROP SCHEMA ${qIdent(name)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Views (regular + materialized) -----
app.get('/api/db/views', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  try {
    const r = await getPool(req).query(`
      SELECT c.relname AS name,
             c.relkind AS kind,
             pg_get_userbyid(c.relowner) AS owner,
             pg_get_viewdef(c.oid, true) AS definition
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('v','m') AND n.nspname = $1
      ORDER BY c.relname
    `, [schema]);
    res.json({ views: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/view/create', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', name, sql: body, materialized, replace } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const select = validBody(body);
    // OR REPLACE is only valid for regular views.
    const head = materialized
      ? 'CREATE MATERIALIZED VIEW'
      : `CREATE ${replace ? 'OR REPLACE ' : ''}VIEW`;
    const sql = `${head} ${fqTable(schema, name)} AS\n${select}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/view/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', name, materialized, cascade } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `DROP ${materialized ? 'MATERIALIZED ' : ''}VIEW ${fqTable(schema, name)}${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/view/refresh', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `REFRESH MATERIALIZED VIEW ${fqTable(schema, name)}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Functions / procedures -----
app.get('/api/db/functions', requireAuth, requireDb, async (req, res) => {
  const schema = String(req.query.schema || 'public');
  try {
    const r = await getPool(req).query(`
      SELECT p.oid::bigint AS oid,
             p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS returns,
             l.lanname AS language,
             p.prokind AS kind
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l  ON l.oid = p.prolang
      WHERE n.nspname = $1 AND p.prokind IN ('f','p')
      ORDER BY p.proname, args
    `, [schema]);
    res.json({ functions: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Source is fetched on demand: pg_get_functiondef() throws for some builtins,
// so keeping it out of the list query keeps the listing robust.
app.get('/api/db/function-def', requireAuth, requireDb, async (req, res) => {
  const oid = String(req.query.oid || '');
  if (!/^\d+$/.test(oid)) return res.status(400).json({ error: 'invalid_oid' });
  try {
    const r = await getPool(req).query('SELECT pg_get_functiondef($1::oid) AS def', [oid]);
    res.json({ definition: r.rows[0] ? r.rows[0].def : null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Functions are created by submitting the whole CREATE statement: bodies are
// arbitrary SQL/PLpgSQL, so there is nothing meaningful to assemble field-wise.
app.post('/api/ddl/function/create', requireAuth, requireDb, async (req, res) => {
  const { sql: body } = req.body || {};
  try {
    const s = validBody(body, { allowSemicolons: true });
    if (!/^\s*create\b/i.test(s) || !/\b(function|procedure)\b/i.test(s)) {
      throw new Error('statement must be a CREATE FUNCTION / CREATE PROCEDURE');
    }
    await getPool(req).query(s);
    res.json({ ok: true, sql: s });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/function/drop', requireAuth, requireDb, async (req, res) => {
  const { schema = 'public', name, args = '', procedure, cascade } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const a = String(args || '');
  if (a && !TYPE_RE.test(a)) return res.status(400).json({ error: 'invalid_arguments' });
  try {
    const sql = `DROP ${procedure ? 'PROCEDURE' : 'FUNCTION'} ${fqTable(schema, name)}(${a})${cascade ? ' CASCADE' : ''}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ----- Roles -----
app.get('/api/db/roles', requireAuth, requireDb, async (req, res) => {
  try {
    const r = await getPool(req).query(`
      SELECT rolname AS name, rolsuper AS superuser, rolcreatedb AS createdb,
             rolcreaterole AS createrole, rolcanlogin AS login,
             rolreplication AS replication, rolinherit AS inherit,
             rolconnlimit AS connlimit, rolvaliduntil AS valid_until
      FROM pg_roles
      WHERE rolname NOT LIKE 'pg\\_%'
      ORDER BY rolname
    `);
    res.json({ roles: r.rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Shared option builder for CREATE/ALTER ROLE. Password is escaped by the server
// via quote_literal() and is never logged or echoed back.
async function roleOptions(pool, o) {
  const parts = [];
  if (typeof o.login === 'boolean') parts.push(o.login ? 'LOGIN' : 'NOLOGIN');
  if (typeof o.superuser === 'boolean') parts.push(o.superuser ? 'SUPERUSER' : 'NOSUPERUSER');
  if (typeof o.createdb === 'boolean') parts.push(o.createdb ? 'CREATEDB' : 'NOCREATEDB');
  if (typeof o.createrole === 'boolean') parts.push(o.createrole ? 'CREATEROLE' : 'NOCREATEROLE');
  if (typeof o.inherit === 'boolean') parts.push(o.inherit ? 'INHERIT' : 'NOINHERIT');
  if (o.connlimit !== undefined && o.connlimit !== null && o.connlimit !== '') {
    const n = Number(o.connlimit);
    if (!Number.isInteger(n) || n < -1) throw new Error('invalid connection limit');
    parts.push(`CONNECTION LIMIT ${n}`);
  }
  if (o.password) parts.push(`PASSWORD ${await sqlLiteral(pool, o.password)}`);
  return parts;
}

app.post('/api/ddl/role/create', requireAuth, requireDb, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const pool = getPool(req);
    const opts = await roleOptions(pool, req.body || {});
    const sql = `CREATE ROLE ${qIdent(name)}${opts.length ? ' ' + opts.join(' ') : ''}`;
    await pool.query(sql);
    res.json({ ok: true, sql: sql.replace(/PASSWORD '.*'/, "PASSWORD '***'") });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/role/alter', requireAuth, requireDb, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const pool = getPool(req);
    const opts = await roleOptions(pool, req.body || {});
    if (opts.length === 0) return res.status(400).json({ error: 'nothing_to_change' });
    const sql = `ALTER ROLE ${qIdent(name)} ${opts.join(' ')}`;
    await pool.query(sql);
    res.json({ ok: true, sql: sql.replace(/PASSWORD '.*'/, "PASSWORD '***'") });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/ddl/role/drop', requireAuth, requireDb, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  try {
    const sql = `DROP ROLE ${qIdent(name)}`;
    await getPool(req).query(sql);
    res.json({ ok: true, sql });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- Full database export / import (pg_dump / pg_restore / psql) ----------
// These shell out to the libpq CLI tools with an args ARRAY (never a shell string),
// so nothing here is injectable. The DB password travels via the PGPASSWORD env var
// (not visible in `ps`); all other flags come from fixed whitelists and
// server-generated temp paths. No privilege beyond the user's existing SQL access.

function getConnString(req) {
  return pools.get(req.sessionID)?.connectionString || null;
}

// Connection-string query parameters libpq understands. ORMs append extras the
// node `pg` driver quietly ignores (Prisma's ?schema=, ?pgbouncer=,
// ?connection_limit=, ...), but pg_dump/psql/pg_restore reject the whole URI with
// "invalid URI query parameter", so anything outside this set is stripped.
const LIBPQ_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'dbname', 'user', 'password', 'passfile', 'require_auth',
  'channel_binding', 'connect_timeout', 'client_encoding', 'options', 'application_name',
  'fallback_application_name', 'keepalives', 'keepalives_idle', 'keepalives_interval',
  'keepalives_count', 'tcp_user_timeout', 'replication', 'gssencmode', 'sslmode',
  'requiressl', 'sslnegotiation', 'sslcompression', 'sslcert', 'sslkey', 'sslpassword',
  'sslcertmode', 'sslrootcert', 'sslcrl', 'sslcrldir', 'sslsni', 'requirepeer',
  'ssl_min_protocol_version', 'ssl_max_protocol_version', 'krbsrvname', 'gsslib',
  'gssdelegation', 'service', 'target_session_attrs', 'load_balance_hosts',
]);

// Turn a connection string into { arg, env } for libpq tools. The password is
// stripped out of the URI and moved to PGPASSWORD so it never lands on argv, and
// non-libpq query parameters are dropped so the CLI tools accept the URI.
function pgToolConn(cs) {
  const env = { ...process.env };
  try {
    const u = new URL(cs);
    if (u.password) { env.PGPASSWORD = decodeURIComponent(u.password); u.password = ''; }
    for (const key of [...u.searchParams.keys()]) {
      if (!LIBPQ_PARAMS.has(key)) u.searchParams.delete(key);
    }
    return { arg: u.toString(), env };
  } catch (_) {
    return { arg: cs, env }; // libpq key=value DSN — pass through unchanged
  }
}

function tmpFile(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(9).toString('hex')}`);
}

function safeUnlink(p) { if (p) fs.unlink(p, () => { }); }

// Cap collected stderr/stdout so a chatty tool cannot exhaust memory.
function tailCollector(limit = 200_000) {
  let s = '';
  return {
    push(buf) { s += buf.toString(); if (s.length > limit) s = s.slice(-limit); },
    get text() { return s.trim(); },
  };
}

// Prepared dumps waiting to be downloaded: id -> { sid, path, filename, timer }.
const pendingDumps = new Map();
const DUMP_TTL_MS = 10 * 60 * 1000;

const EXPORT_FORMAT = { custom: '-Fc', plain: '-Fp', tar: '-Ft' };
const EXPORT_EXT = { custom: 'dump', plain: 'sql', tar: 'tar' };

// Step 1: run pg_dump into a temp file. Returns an id to download (or a JSON error).
app.post('/api/db/export', requireAuth, requireDb, (req, res) => {
  const cs = getConnString(req);
  if (!cs) return res.status(409).json({ error: 'no_connection_string', detail: 'Reconnect to enable export.' });
  const { format = 'custom', scope, portable = true } = req.body || {};
  if (!EXPORT_FORMAT[format]) return res.status(400).json({ error: 'invalid_format' });

  const { arg, env } = pgToolConn(cs);
  const out = tmpFile('pbdump');
  const args = ['-d', arg, EXPORT_FORMAT[format], '-f', out];
  if (portable) args.push('--no-owner', '--no-privileges');
  if (scope === 'schema') args.push('--schema-only');
  else if (scope === 'data') args.push('--data-only');

  const child = spawn('pg_dump', args, { env });
  const errc = tailCollector();
  child.stderr.on('data', d => errc.push(d));
  child.on('error', (e) => { safeUnlink(out); if (!res.headersSent) res.status(500).json({ error: 'pg_dump_unavailable', detail: e.message }); });
  child.on('close', (code) => {
    if (code !== 0) { safeUnlink(out); return res.status(400).json({ error: 'pg_dump_failed', detail: errc.text || `exit ${code}` }); }
    let bytes = 0;
    try { bytes = fs.statSync(out).size; } catch (_) { }
    const db = pools.get(req.sessionID)?.info?.db || 'database';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `${db}-${stamp}.${EXPORT_EXT[format]}`;
    const id = crypto.randomBytes(12).toString('hex');
    const timer = setTimeout(() => { pendingDumps.delete(id); safeUnlink(out); }, DUMP_TTL_MS);
    pendingDumps.set(id, { sid: req.sessionID, path: out, filename, timer });
    res.json({ ok: true, id, filename, bytes });
  });
});

// Step 2: stream the prepared dump as a download, then delete it.
app.get('/api/db/export/download/:id', requireAuth, (req, res) => {
  const entry = pendingDumps.get(req.params.id);
  if (!entry || entry.sid !== req.sessionID) return res.status(404).json({ error: 'not_found' });
  clearTimeout(entry.timer);
  pendingDumps.delete(req.params.id);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
  const stream = fs.createReadStream(entry.path);
  stream.on('error', () => { safeUnlink(entry.path); if (!res.headersSent) res.status(500).end(); });
  stream.on('close', () => safeUnlink(entry.path));
  stream.pipe(res);
});

// Import: the raw request body IS the dump file (sent as octet-stream, so the JSON
// body parser skips it and we stream straight to disk — no size ceiling from the
// 32mb JSON limit). Options ride on the query string.
const IMPORT_MAX_BYTES = Number(process.env.IMPORT_MAX_BYTES || 4 * 1024 * 1024 * 1024);
app.post('/api/db/import', requireAuth, requireDb, (req, res) => {
  const cs = getConnString(req);
  if (!cs) return res.status(409).json({ error: 'no_connection_string', detail: 'Reconnect to enable import.' });
  const clean = req.query.clean === '1';
  const stopOnError = req.query.stop === '1';

  const file = tmpFile('pbimport');
  const ws = fs.createWriteStream(file);
  let size = 0, aborted = false;
  req.on('data', (d) => {
    size += d.length;
    if (size > IMPORT_MAX_BYTES && !aborted) {
      aborted = true; req.destroy(); ws.destroy(); safeUnlink(file);
      if (!res.headersSent) res.status(413).json({ error: 'file_too_large' });
    }
  });
  ws.on('error', () => { if (!aborted && !res.headersSent) { safeUnlink(file); res.status(500).json({ error: 'write_failed' }); } });
  req.on('error', () => { if (!aborted) { safeUnlink(file); ws.destroy(); } });
  ws.on('finish', () => {
    if (aborted) return;
    // Detect custom/tar dumps by their leading "PGDMP" magic; else treat as plain SQL.
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      const n = fs.readSync(fd, b, 0, 5, 0);
      fs.closeSync(fd);
      magic = b.slice(0, n).toString('latin1');
    } catch (_) { }
    const isArchive = magic === 'PGDMP';
    const { arg, env } = pgToolConn(cs);

    let cmd, args;
    if (isArchive) {
      cmd = 'pg_restore';
      args = ['-d', arg, '--no-owner', '--no-privileges'];
      if (clean) args.push('--clean', '--if-exists');
      if (stopOnError) args.push('--exit-on-error');
      args.push(file);
    } else {
      cmd = 'psql';
      args = ['-d', arg, '-v', `ON_ERROR_STOP=${stopOnError ? 1 : 0}`, '-f', file];
    }

    const child = spawn(cmd, args, { env });
    const outc = tailCollector(), errc = tailCollector();
    child.stdout.on('data', d => outc.push(d));
    child.stderr.on('data', d => errc.push(d));
    child.on('error', (e) => { safeUnlink(file); if (!res.headersSent) res.status(500).json({ error: 'tool_unavailable', detail: e.message }); });
    child.on('close', (code) => {
      safeUnlink(file);
      if (res.headersSent) return;
      res.json({ ok: code === 0, format: isArchive ? 'custom/tar' : 'plain', tool: cmd, code, stdout: outc.text, stderr: errc.text });
    });
  });
  req.pipe(ws);
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
