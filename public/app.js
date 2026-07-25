'use strict';

// ---------------- State ----------------
const state = {
  connected: false,
  info: null,
  schemas: [],
  schema: 'public',
  tables: [],
  table: null,
  columns: [],
  primaryKey: [],
  rows: [],
  fields: [],
  total: 0,
  limit: 50,
  offset: 0,
  orderBy: null,
  orderDir: 'ASC',
  indexes: [],
  constraints: [],
  dbSchemas: [],
  views: [],
  functions: [],
  roles: [],
  view: 'tables', // 'tables' | 'structure' | 'database' | 'sql' | 'map'
  // Selection for bulk operations. Keyed by JSON.stringify(pkObject).
  selection: new Set(),
};

// ---------------- DOM helpers ----------------
const $ = (s, p = document) => p.querySelector(s);
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'style') e.style.cssText = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else if (attrs[k] === true) e.setAttribute(k, '');
    else if (attrs[k] != null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
function fmtCell(v) {
  if (v === null || v === undefined) return el('span', { class: 'null' }, 'NULL');
  if (typeof v === 'object') return document.createTextNode(JSON.stringify(v));
  return document.createTextNode(String(v));
}
// Inline monochrome line icons (Feather-style, inherit currentColor).
const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
};
function icon(name) {
  const span = el('span', { class: 'icon' });
  span.innerHTML = ICONS[name] || '';
  return span;
}

// ---------------- API ----------------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || r.statusText);
    err.detail = j.detail; err.body = j;
    throw err;
  }
  return j;
}

// ---------------- Modal ----------------
function modal({ title, body, actions }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const m = el('div', { class: 'modal' });
  const closeBtn = el('button', { class: 'ghost', onclick: close }, '×');
  m.appendChild(el('header', {}, el('h3', {}, title), closeBtn));
  m.appendChild(el('div', { class: 'body' }, body));
  const footer = el('footer', {});
  for (const a of actions) {
    const b = el('button', { class: a.class || '', onclick: () => a.onClick(close) }, a.label);
    footer.appendChild(b);
  }
  m.appendChild(footer);
  backdrop.appendChild(m);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  function close() { backdrop.remove(); }
  return { close };
}

// ---------------- Header / boot ----------------
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
});
$('#disconnectBtn').addEventListener('click', async () => {
  await api('/api/disconnect', { method: 'POST' });
  state.connected = false; state.info = null;
  renderAll();
});

(async function init() {
  const me = await api('/api/me');
  if (!me.auth) { location.href = '/'; return; }
  state.connected = !!me.connected;
  state.info = me.info;
  state.defaultPgUrl = me.defaultPgUrl || '';
  if (state.connected) await loadSchemas();
  renderAll();
})();

// ---------------- Render ----------------
function renderAll() {
  renderHeader();
  renderSide();
  renderMain();
}

function renderHeader() {
  const info = $('#connInfo');
  const disc = $('#disconnectBtn');
  if (state.connected && state.info) {
    info.textContent = `${state.info.usr}@${state.info.db}`;
    disc.style.display = '';
  } else {
    info.textContent = '';
    disc.style.display = 'none';
  }
}

function renderSide() {
  const side = $('#side'); side.innerHTML = '';
  if (!state.connected) return;

  // nav
  const navSec = el('div', { class: 'section' });
  navSec.appendChild(el('h3', {}, 'View'));
  navSec.appendChild(el('button', {
    class: 'nav-btn' + (state.view === 'tables' ? ' active' : ''),
    onclick: () => { state.view = 'tables'; renderMain(); renderSide(); },
  }, 'Tables'));
  navSec.appendChild(el('button', {
    class: 'nav-btn' + (state.view === 'structure' ? ' active' : ''),
    onclick: () => { state.view = 'structure'; renderMain(); renderSide(); },
  }, 'Structure'));
  navSec.appendChild(el('button', {
    class: 'nav-btn' + (state.view === 'database' ? ' active' : ''),
    onclick: () => { state.view = 'database'; renderMain(); renderSide(); },
  }, 'Database'));
  navSec.appendChild(el('button', {
    class: 'nav-btn' + (state.view === 'map' ? ' active' : ''),
    onclick: () => { state.view = 'map'; renderMain(); renderSide(); },
  }, 'Map'));
  navSec.appendChild(el('button', {
    class: 'nav-btn' + (state.view === 'sql' ? ' active' : ''),
    onclick: () => { state.view = 'sql'; renderMain(); renderSide(); },
  }, 'SQL'));
  side.appendChild(navSec);

  // schema selector
  const schemaSec = el('div', { class: 'section' });
  schemaSec.appendChild(el('h3', {}, 'Schema'));
  const sel = el('select', {
    onchange: async (e) => {
      state.schema = e.target.value;
      state.table = null;
      await loadTables();
      renderSide(); renderMain();
    },
  });
  for (const s of state.schemas) {
    const o = el('option', { value: s }, s);
    if (s === state.schema) o.selected = true;
    sel.appendChild(o);
  }
  schemaSec.appendChild(sel);
  side.appendChild(schemaSec);

  // tables
  const tSec = el('div', { class: 'section' });
  tSec.appendChild(el('div', { class: 'sec-head' },
    el('h3', {}, `Tables (${state.tables.length})`),
    el('button', { class: 'ghost sm', title: 'New table', onclick: () => openCreateTable() }, '+'),
  ));
  const list = el('div', { class: 'table-list' });
  for (const t of state.tables) {
    const it = el('div', {
      class: 'item' + (state.table === t.table_name ? ' active' : ''),
      title: t.table_type,
      onclick: () => selectTable(t.table_name),
    }, t.table_name);
    list.appendChild(it);
  }
  if (state.tables.length === 0) list.appendChild(el('div', { class: 'empty' }, 'No tables'));
  tSec.appendChild(list);
  side.appendChild(tSec);
}

function renderMain() {
  const main = $('#main'); main.innerHTML = '';
  if (!state.connected) return renderConnect(main);
  if (state.view === 'structure') return renderStructure(main);
  if (state.view === 'database') return renderDatabase(main);
  if (state.view === 'map') return renderMap(main);
  if (state.view === 'sql') return renderSql(main);
  if (!state.table) {
    main.appendChild(el('div', { class: 'empty' }, 'Select a table from the left.'));
    return;
  }
  renderTable(main);
}

// ---------------- Connect view ----------------
// Establish a pool (by saved id or raw connection string) and enter the app.
async function doConnect(body) {
  const j = await api('/api/connect', { method: 'POST', body });
  state.connected = true; state.info = j.info;
  await loadSchemas();
  renderAll();
}

// Fill `container` with the list of previously-used connections (one-click reconnect).
async function renderSavedConnections(container) {
  container.innerHTML = '';
  let conns = [];
  try { conns = (await api('/api/connections')).connections || []; } catch (_) { return; }
  if (conns.length === 0) return;

  container.appendChild(el('label', {}, 'Recent connections'));
  const listEl = el('div', { class: 'conn-list' });
  for (const c of conns) {
    const sub = `${c.user ? c.user + '@' : ''}${c.host || ''}${c.port ? ':' + c.port : ''}${c.db ? '/' + c.db : ''}`;
    const card = el('div', { class: 'conn-card' });

    const connectBtn = el('button', {
      class: 'conn-open', title: 'Reconnect',
      onclick: async () => {
        connectBtn.disabled = true; connectBtn.classList.add('loading');
        try {
          await doConnect({ id: c.id });
        } catch (e) {
          connectBtn.disabled = false; connectBtn.classList.remove('loading');
          alert('Connect failed: ' + e.message);
        }
      },
    },
      el('div', { class: 'conn-label' }, c.label || c.db || 'connection'),
      el('div', { class: 'conn-sub' }, sub || '—'),
    );

    const editBtn = el('button', {
      class: 'ghost sm', title: 'Rename',
      onclick: async (e) => {
        e.stopPropagation();
        const name = prompt('Label for this connection:', c.label || '');
        if (name == null) return;
        try {
          await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'PATCH', body: { label: name } });
          renderSavedConnections(container);
        } catch (err) { alert('Rename failed: ' + err.message); }
      },
    }, icon('edit'));

    const delBtn = el('button', {
      class: 'ghost sm danger', title: 'Remove',
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove saved connection "${c.label || sub}"?`)) return;
        try {
          await api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
          renderSavedConnections(container);
        } catch (err) { alert('Remove failed: ' + err.message); }
      },
    }, icon('trash'));

    card.appendChild(connectBtn);
    card.appendChild(el('div', { class: 'conn-actions' }, editBtn, delBtn));
    listEl.appendChild(card);
  }
  container.appendChild(listEl);
}

function renderConnect(root) {
  const wrap = el('div', { class: 'connect-wrap' });
  wrap.appendChild(el('h2', {}, 'Connect to PostgreSQL'));

  // Previously-used connections (populated async).
  const savedWrap = el('div', { class: 'saved-conns' });
  wrap.appendChild(savedWrap);
  renderSavedConnections(savedWrap);

  wrap.appendChild(el('label', { for: 'cs' }, 'New connection string'));
  const input = el('input', {
    id: 'cs', type: 'text',
    placeholder: 'postgres://user:pass@host:5432/dbname',
    value: state.defaultPgUrl || '',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  wrap.appendChild(input);
  wrap.appendChild(el('p', { class: 'hint' }, 'Format: postgres://user:password@host:port/database. SSL options can be appended as query parameters. Successful connections are saved here for one-click reconnect.'));
  const err = el('div', { class: 'error' });
  const btn = el('button', {
    class: 'primary',
    onclick: async () => {
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        await doConnect({ connectionString: input.value });
      } catch (e) {
        err.textContent = e.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Connect';
      }
    },
  }, 'Connect');
  wrap.appendChild(btn);
  wrap.appendChild(err);
  root.appendChild(wrap);
}

// ---------------- Loading ----------------
async function loadSchemas() {
  const r = await api('/api/schemas');
  state.schemas = r.schemas;
  if (!state.schemas.includes(state.schema)) state.schema = state.schemas[0] || 'public';
  await loadTables();
}
async function loadTables() {
  if (!state.schema) { state.tables = []; return; }
  const r = await api(`/api/tables?schema=${encodeURIComponent(state.schema)}`);
  state.tables = r.tables;
}
async function selectTable(name) {
  state.table = name;
  state.offset = 0; state.orderBy = null;
  state.filter = null;
  state.selection = new Set();
  await loadColumns();
  await loadRows();
  renderSide(); renderMain();
}

// Build a stable selection key from a row's primary key columns.
function rowSelKey(row) {
  if (!state.primaryKey || state.primaryKey.length === 0) return null;
  const pk = {};
  for (const k of state.primaryKey) pk[k] = row[k];
  return JSON.stringify(pk);
}
function rowSelPk(row) {
  const pk = {};
  for (const k of state.primaryKey) pk[k] = row[k];
  return pk;
}
async function loadColumns() {
  const r = await api(`/api/columns?schema=${encodeURIComponent(state.schema)}&table=${encodeURIComponent(state.table)}`);
  state.columns = applyColOrder(r.columns);
  state.primaryKey = r.primaryKey;
  state.outgoingFks = r.outgoingFks || [];
  state.incomingFks = r.incomingFks || [];
  state.uniqueConstraints = r.uniqueConstraints || [];
  // Map: column_name -> { refSchema, refTable, refColumn } (only for single-column FKs)
  state.fkByColumn = {};
  for (const fk of state.outgoingFks) {
    if (fk.columns.length === 1) {
      state.fkByColumn[fk.columns[0]] = {
        refSchema: fk.refSchema, refTable: fk.refTable, refColumn: fk.refColumns[0],
      };
    }
  }
}
async function loadRows() {
  if (state.filter && Object.keys(state.filter).length > 0) {
    const r = await api('/api/related', {
      method: 'POST',
      body: {
        schema: state.schema, table: state.table,
        where: state.filter, limit: state.limit, offset: state.offset,
      },
    });
    state.rows = r.rows; state.fields = r.fields; state.total = r.total;
    return;
  }
  const params = new URLSearchParams({
    schema: state.schema, table: state.table,
    limit: state.limit, offset: state.offset,
  });
  if (state.orderBy) { params.set('orderBy', state.orderBy); params.set('orderDir', state.orderDir); }
  const r = await api('/api/rows?' + params.toString());
  state.rows = r.rows; state.fields = r.fields; state.total = r.total;
}

// ---------------- Table view ----------------
function renderTable(root) {
  const toolbar = el('div', { class: 'toolbar' });
  toolbar.appendChild(el('span', { class: 'title' }, `${state.schema}.${state.table}`));
  if (state.filter && Object.keys(state.filter).length > 0) {
    const txt = Object.entries(state.filter).map(([k, v]) => `${k}=${v === null ? 'NULL' : v}`).join(', ');
    const chip = el('span', { class: 'chip', title: 'Active filter from related navigation' }, `filter: ${txt}`);
    toolbar.appendChild(chip);
    toolbar.appendChild(el('button', {
      onclick: async () => { state.filter = null; state.offset = 0; await loadRows(); renderMain(); },
    }, 'Clear'));
  }
  toolbar.appendChild(el('button', {
    class: 'primary',
    onclick: () => openRowEditor({ mode: 'insert' }),
  }, '+ Insert row'));
  toolbar.appendChild(el('button', {
    title: 'Manage columns, indexes and constraints',
    onclick: () => { state.view = 'structure'; renderSide(); renderMain(); },
  }, 'Structure'));
  toolbar.appendChild(el('button', {
    onclick: () => openBulkGenerator(),
    title: 'Insert many rows with random data',
  }, '⚡ Generate rows'));
  toolbar.appendChild(el('button', {
    onclick: () => openExportRows(),
    title: 'Export selection, page, or all rows as CSV / JSON',
  }, '⭳ Export'));
  toolbar.appendChild(el('button', { onclick: refresh }, 'Refresh'));

  // Bulk-delete button: only meaningful when we have a PK and a selection
  if (state.primaryKey.length > 0) {
    const selCount = state.selection.size;
    toolbar.appendChild(el('button', {
      class: 'danger' + (selCount === 0 ? ' ghost' : ''),
      disabled: selCount === 0,
      title: 'Delete the selected rows',
      onclick: () => bulkDeleteSelected(),
    }, selCount > 0 ? `Delete ${selCount} selected` : 'Delete selected'));
    if (selCount > 0) {
      toolbar.appendChild(el('button', {
        class: 'ghost',
        onclick: () => { state.selection = new Set(); renderMain(); },
      }, 'Clear selection'));
    }
  }

  // pagination
  const pageStart = state.total === 0 ? 0 : state.offset + 1;
  const pageEnd = Math.min(state.offset + state.rows.length, state.total);
  toolbar.appendChild(el('span', { class: 'pageinfo' }, `${pageStart}–${pageEnd} of ${state.total}`));
  toolbar.appendChild(el('button', {
    disabled: state.offset === 0,
    onclick: async () => { state.offset = Math.max(0, state.offset - state.limit); await loadRows(); renderMain(); },
  }, '‹ Prev'));
  toolbar.appendChild(el('button', {
    disabled: state.offset + state.limit >= state.total,
    onclick: async () => { state.offset += state.limit; await loadRows(); renderMain(); },
  }, 'Next ›'));
  const limitSel = el('select', {
    onchange: async (e) => { state.limit = parseInt(e.target.value, 10); state.offset = 0; await loadRows(); renderMain(); },
  });
  for (const n of [25, 50, 100, 200, 500]) {
    const o = el('option', { value: n }, `${n}/page`);
    if (n === state.limit) o.selected = true;
    limitSel.appendChild(o);
  }
  toolbar.appendChild(limitSel);
  root.appendChild(toolbar);

  if (state.columns.length === 0) {
    root.appendChild(el('div', { class: 'empty' }, 'No columns.'));
    return;
  }
  const wrap = el('div', { class: 'table-wrap' });
  const tbl = el('table', { class: 'data' });
  const thead = el('thead');
  const hr = el('tr');

  // Select-all checkbox (header). Only when this table has a PK.
  const hasPk = state.primaryKey.length > 0;
  if (hasPk) {
    const pageKeys = state.rows.map(rowSelKey).filter(Boolean);
    const allOnPageSelected = pageKeys.length > 0 && pageKeys.every(k => state.selection.has(k));
    const someOnPage = pageKeys.some(k => state.selection.has(k));
    const headCb = el('input', {
      type: 'checkbox',
      title: 'Select all rows on this page',
      onclick: (e) => {
        if (e.target.checked) {
          for (const k of pageKeys) state.selection.add(k);
        } else {
          for (const k of pageKeys) state.selection.delete(k);
        }
        renderMain();
      },
    });
    if (allOnPageSelected) headCb.checked = true;
    if (!allOnPageSelected && someOnPage) headCb.indeterminate = true;
    hr.appendChild(el('th', { class: 'sel-col' }, headCb));
  }

  for (const c of state.columns) {
    const isOrder = state.orderBy === c.column_name;
    const arrow = isOrder ? (state.orderDir === 'ASC' ? ' ↑' : ' ↓') : '';
    const isPk = state.primaryKey.includes(c.column_name);
    const fk = state.fkByColumn[c.column_name];
    const fkMark = fk ? '→ ' : '';
    const titleParts = [c.data_type];
    if (isPk) titleParts.push('PK');
    if (fk) titleParts.push(`FK → ${fk.refSchema}.${fk.refTable}.${fk.refColumn}`);
    hr.appendChild(el('th', {
      title: titleParts.join(' · '),
      onclick: async () => {
        if (state.orderBy === c.column_name) {
          state.orderDir = state.orderDir === 'ASC' ? 'DESC' : 'ASC';
        } else {
          state.orderBy = c.column_name; state.orderDir = 'ASC';
        }
        state.offset = 0;
        await loadRows(); renderMain();
      },
    }, (isPk ? '🔑 ' : '') + fkMark + c.column_name + arrow));
  }
  hr.appendChild(el('th', {}, ''));
  thead.appendChild(hr);
  tbl.appendChild(thead);

  const tbody = el('tbody');
  for (const row of state.rows) {
    const tr = el('tr');
    // Selection checkbox
    if (hasPk) {
      const k = rowSelKey(row);
      const selected = k && state.selection.has(k);
      if (selected) tr.classList.add('selected');
      const cb = el('input', {
        type: 'checkbox',
        onclick: (e) => {
          if (!k) return;
          if (e.target.checked) state.selection.add(k);
          else state.selection.delete(k);
          renderMain();
        },
      });
      if (selected) cb.checked = true;
      tr.appendChild(el('td', { class: 'sel-col' }, cb));
    }
    for (const c of state.columns) {
      const v = row[c.column_name];
      const fk = state.fkByColumn[c.column_name];
      const td = el('td', { title: v === null ? 'NULL' : String(v ?? '') });
      if (fk && v !== null && v !== undefined) {
        const link = el('a', {
          href: '#',
          class: 'fk-link',
          title: `View row in ${fk.refSchema}.${fk.refTable} where ${fk.refColumn} = ${v}`,
          onclick: (e) => {
            e.preventDefault();
            openReferencedRow(fk, v);
          },
        }, String(v));
        td.appendChild(link);
      } else {
        td.appendChild(fmtCell(v));
      }
      tr.appendChild(td);
    }
    const actTd = el('td', { class: 'actions' });
    if (state.incomingFks.length > 0 && state.primaryKey.length > 0) {
      actTd.appendChild(el('button', { onclick: () => openRelatedPanel(row), title: 'Show related rows from other tables' }, 'Related'));
    }
    if (state.primaryKey.length > 0) {
      actTd.appendChild(el('button', { onclick: () => openRowEditor({ mode: 'edit', row }) }, 'Edit'));
      actTd.appendChild(el('button', { class: 'danger', onclick: () => deleteRow(row) }, 'Delete'));
    } else {
      actTd.appendChild(el('span', { class: 'null' }, 'no PK'));
    }
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  if (state.rows.length === 0) wrap.appendChild(el('div', { class: 'empty' }, 'No rows.'));
  root.appendChild(wrap);
}

async function refresh() {
  await loadColumns();
  await loadRows();
  renderMain();
}

async function deleteRow(row) {
  if (!confirm('Delete this row? This cannot be undone.')) return;
  const pk = {};
  for (const k of state.primaryKey) pk[k] = row[k];
  try {
    await api('/api/delete', { method: 'POST', body: { schema: state.schema, table: state.table, pk } });
    await loadRows(); renderMain();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

async function bulkDeleteSelected() {
  if (state.primaryKey.length === 0) return;
  if (state.selection.size === 0) return;
  const pks = [];
  for (const key of state.selection) {
    try { pks.push(JSON.parse(key)); } catch (_) { }
  }
  if (pks.length === 0) return;
  if (!confirm(`Delete ${pks.length} selected row${pks.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  try {
    const r = await api('/api/delete-bulk', {
      method: 'POST',
      body: { schema: state.schema, table: state.table, pks },
    });
    state.selection = new Set();
    await loadRows(); renderMain();
    console.log(`Deleted ${r.affected} rows`);
  } catch (e) {
    alert('Bulk delete failed: ' + e.message);
  }
}

// ---------------- Related rows ----------------
function renderRowsTable(rowsArr, fields) {
  if (!rowsArr || rowsArr.length === 0) return el('div', { class: 'empty' }, 'No rows.');
  const wrap = el('div', { class: 'table-wrap', style: 'max-height:50vh' });
  const tbl = el('table', { class: 'data' });
  const thead = el('thead'); const hr = el('tr');
  const cols = fields && fields.length ? fields.map(f => f.name) : Object.keys(rowsArr[0]);
  for (const name of cols) hr.appendChild(el('th', {}, name));
  thead.appendChild(hr); tbl.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rowsArr) {
    const tr = el('tr');
    for (const name of cols) {
      const td = el('td', { title: row[name] === null ? 'NULL' : String(row[name] ?? '') });
      td.appendChild(fmtCell(row[name]));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody); wrap.appendChild(tbl);
  return wrap;
}

async function openReferencedRow(fk, value) {
  const body = el('div');
  body.appendChild(el('div', { class: 'notice' }, `Looking up ${fk.refSchema}.${fk.refTable} where ${fk.refColumn} = ${value}\u2026`));
  const m = modal({
    title: `\u2192 ${fk.refSchema}.${fk.refTable}`,
    body,
    actions: [
      { label: 'Open table', onClick: (close) => { close(); navigateToTable(fk.refSchema, fk.refTable); } },
      { label: 'Close', class: 'primary', onClick: (close) => close() },
    ],
  });
  try {
    const r = await api('/api/related', {
      method: 'POST',
      body: { schema: fk.refSchema, table: fk.refTable, where: { [fk.refColumn]: value }, limit: 5 },
    });
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'notice' }, `${r.total} row(s) matched`));
    body.appendChild(renderRowsTable(r.rows, r.fields));
  } catch (e) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'notice error' }, e.message));
  }
}

async function openRelatedPanel(row) {
  const body = el('div');
  if (state.incomingFks.length === 0) {
    body.appendChild(el('div', { class: 'empty' }, 'No incoming foreign keys.'));
  }
  modal({
    title: `Related rows for ${state.schema}.${state.table}`,
    body,
    actions: [{ label: 'Close', class: 'primary', onClick: (close) => close() }],
  });

  for (const fk of state.incomingFks) {
    // Build WHERE: each fk.columns[i] = row[fk.refColumns[i]]
    const where = {};
    let skip = false;
    for (let i = 0; i < fk.columns.length; i++) {
      const v = row[fk.refColumns[i]];
      if (v === undefined) { skip = true; break; }
      where[fk.columns[i]] = v;
    }
    if (skip) continue;

    const section = el('div', { class: 'related-section' });
    const headerLine = el('div', { class: 'related-header' });
    const refColsTxt = fk.columns.join(', ');
    const titleBtn = el('button', {
      class: 'ghost',
      title: 'Open in table view',
      onclick: () => navigateToTable(fk.schema, fk.table, where),
    }, `${fk.schema}.${fk.table} (via ${refColsTxt})`);
    headerLine.appendChild(titleBtn);
    const countSpan = el('span', { class: 'pageinfo' }, '\u2026');
    headerLine.appendChild(countSpan);
    section.appendChild(headerLine);
    const slot = el('div', {}, el('div', { class: 'notice' }, 'Loading\u2026'));
    section.appendChild(slot);
    body.appendChild(section);

    try {
      const r = await api('/api/related', {
        method: 'POST',
        body: { schema: fk.schema, table: fk.table, where, limit: 10 },
      });
      countSpan.textContent = `${r.total} row(s)`;
      slot.innerHTML = '';
      slot.appendChild(renderRowsTable(r.rows, r.fields));
      if (r.total > r.rows.length) {
        slot.appendChild(el('div', { class: 'notice' }, `Showing first ${r.rows.length} of ${r.total}. Click table name to open.`));
      }
    } catch (e) {
      countSpan.textContent = 'error';
      slot.innerHTML = '';
      slot.appendChild(el('div', { class: 'notice error' }, e.message));
    }
  }
}

async function navigateToTable(schema, table, filter) {
  if (state.schema !== schema) {
    state.schema = schema;
    await loadTables();
  }
  state.table = table;
  state.offset = 0; state.orderBy = null;
  state.filter = filter || null;
  await loadColumns();
  await loadRows();
  // Close any open modals
  document.querySelectorAll('.modal-backdrop').forEach(n => n.remove());
  renderSide(); renderMain();
}

// ---------------- Array column helpers ----------------
// Postgres array columns report data_type === 'ARRAY' with udt_name like '_text' / '_int4'.
const NUMERIC_ARRAY_UDT = new Set(['_int2', '_int4', '_int8', '_float4', '_float8', '_numeric', '_oid']);

// Turn the edit-field string into a JS array (node-postgres formats a JS array into a
// valid array literal) or null. Accepts JSON (["a","b"] / [1,2]) or a Postgres literal
// ({a,b}); a blank field becomes null when the column is nullable, else an empty array.
function parseArrayInput(raw, numeric, nullable) {
  let s = String(raw).trim();
  if (s === '') return nullable ? null : [];
  if (s[0] === '[') {
    try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch (_) { /* fall through */ }
  }
  if (s[0] === '{' && s[s.length - 1] === '}') s = s.slice(1, -1).trim();
  if (s === '') return [];
  const parts = s.split(',').map(x => x.trim().replace(/^"([\s\S]*)"$/, '$1'));
  return numeric ? parts.map(Number) : parts;
}

// ---------------- Row editor ----------------
function openRowEditor({ mode, row }) {
  const body = el('div');
  const inputs = {}; // col -> { value, nullCb, isNull, useDefaultCb }

  for (const c of state.columns) {
    const field = el('div', { class: 'field' });
    const labelTxt = c.column_name;
    const label = el('label', {}, labelTxt, el('span', { class: 'col-type' }, c.data_type + (c.is_nullable === 'YES' ? ' · nullable' : '')));
    field.appendChild(label);

    const curVal = row ? row[c.column_name] : null;
    const isLong = ['json', 'jsonb', 'text'].some(t => c.data_type.includes(t));
    const fk = state.fkByColumn[c.column_name];
    const isEnum = Array.isArray(c.enum_values) && c.enum_values.length > 0;
    const isBool = c.data_type === 'boolean';
    const isArray = c.data_type === 'ARRAY';
    let input;
    let kind = 'input'; // 'input' | 'textarea' | 'select'

    if (isEnum) {
      kind = 'select';
      input = el('select');
      if (c.is_nullable === 'YES') input.appendChild(el('option', { value: '__pb_empty__' }, '(empty)'));
      for (const v of c.enum_values) {
        const o = el('option', { value: v }, v);
        if (curVal != null && String(curVal) === String(v)) o.selected = true;
        input.appendChild(o);
      }
    } else if (isBool) {
      kind = 'select';
      input = el('select');
      for (const [val, lbl] of [['true', 'true'], ['false', 'false']]) {
        const o = el('option', { value: val }, lbl);
        if (curVal != null && String(curVal) === val) o.selected = true;
        input.appendChild(o);
      }
    } else if (fk) {
      kind = 'select';
      input = el('select', { class: 'fk-select' });
      input.appendChild(el('option', { value: '__pb_loading__' }, 'Loading values…'));
      // Async load valid FK values
      (async () => {
        try {
          const r = await api(`/api/fk-values?schema=${encodeURIComponent(fk.refSchema)}&table=${encodeURIComponent(fk.refTable)}&column=${encodeURIComponent(fk.refColumn)}&limit=1000`);
          input.innerHTML = '';
          input.appendChild(el('option', { value: '__pb_unset__' }, `— select ${fk.refTable}.${fk.refColumn} —`));
          for (const v of r.values) {
            const sv = v === null ? '' : String(v);
            const o = el('option', { value: sv }, sv);
            if (curVal != null && String(curVal) === sv) o.selected = true;
            input.appendChild(o);
          }
          if (r.values.length === 1000) {
            input.appendChild(el('option', { value: '__pb_unset__', disabled: true }, `… (showing first 1000)`));
          }
        } catch (e) {
          input.innerHTML = '';
          input.appendChild(el('option', { value: '__pb_unset__' }, `(failed to load: ${e.message})`));
        }
      })();
    } else if (isArray) {
      kind = 'textarea';
      input = el('textarea', { spellcheck: 'false' });
      // Render as JSON so empty arrays show as [] (not blank) and elements round-trip.
      input.value = curVal == null ? '' : (Array.isArray(curVal) ? JSON.stringify(curVal) : String(curVal));
    } else if (isLong) {
      kind = 'textarea';
      input = el('textarea', { spellcheck: 'false' });
      input.value = curVal == null ? '' : (typeof curVal === 'object' ? JSON.stringify(curVal, null, 2) : String(curVal));
    } else {
      input = el('input', { type: 'text', spellcheck: 'false' });
      input.value = curVal == null ? '' : String(curVal);
    }
    field.appendChild(input);

    const cbRow = el('div', { class: 'checkbox-row' });
    const nullCb = el('input', { type: 'checkbox' });
    nullCb.checked = curVal === null;
    nullCb.addEventListener('change', () => { input.disabled = nullCb.checked; });
    if (nullCb.checked) input.disabled = true;
    cbRow.appendChild(nullCb);
    cbRow.appendChild(el('span', {}, 'NULL'));

    let useDefaultCb = null;
    if (mode === 'insert' && c.column_default != null) {
      useDefaultCb = el('input', { type: 'checkbox' });
      useDefaultCb.checked = true;
      useDefaultCb.addEventListener('change', () => {
        input.disabled = useDefaultCb.checked || nullCb.checked;
        nullCb.disabled = useDefaultCb.checked;
      });
      input.disabled = true; nullCb.disabled = true;
      cbRow.appendChild(el('span', { style: 'margin-left:12px' }));
      cbRow.appendChild(useDefaultCb);
      cbRow.appendChild(el('span', {}, `Use default (${String(c.column_default).slice(0, 30)})`));
    }
    field.appendChild(cbRow);
    body.appendChild(field);
    inputs[c.column_name] = { input, nullCb, useDefaultCb, kind, isEnum, isBool, fk };
  }

  modal({
    title: mode === 'insert' ? `Insert into ${state.schema}.${state.table}` : `Edit row in ${state.schema}.${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: mode === 'insert' ? 'Insert' : 'Save',
        class: 'primary',
        onClick: async (close) => {
          const payload = {};
          for (const c of state.columns) {
            const { input, nullCb, useDefaultCb, kind, isEnum, isBool, fk } = inputs[c.column_name];
            if (useDefaultCb && useDefaultCb.checked) continue;
            if (nullCb.checked) { payload[c.column_name] = null; continue; }
            let v = input.value;
            if (kind === 'select') {
              if (v === '__pb_unset__' || v === '__pb_loading__') {
                if (c.is_nullable === 'YES') { payload[c.column_name] = null; continue; }
                throw new Error(`Please choose a value for ${c.column_name}`);
              }
              if (v === '__pb_empty__') { payload[c.column_name] = null; continue; }
              if (isBool) { v = (v === 'true'); }
              // enum / fk: keep as string; pg will coerce FK numeric types
              if (fk && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
              payload[c.column_name] = v;
              continue;
            }
            // Try to coerce numerics / booleans / json / arrays for known types
            if (c.data_type === 'ARRAY') {
              v = parseArrayInput(v, NUMERIC_ARRAY_UDT.has(c.udt_name), c.is_nullable === 'YES');
            } else if (['json', 'jsonb'].some(t => c.data_type.includes(t))) {
              try { v = JSON.parse(v); } catch (_) { /* send as string; server will error if invalid */ }
            } else if (c.data_type === 'boolean') {
              if (v.toLowerCase() === 'true') v = true;
              else if (v.toLowerCase() === 'false') v = false;
            }
            payload[c.column_name] = v;
          }
          try {
            if (mode === 'insert') {
              await api('/api/insert', { method: 'POST', body: { schema: state.schema, table: state.table, row: payload } });
            } else {
              const pk = {};
              for (const k of state.primaryKey) pk[k] = row[k];
              await api('/api/update', { method: 'POST', body: { schema: state.schema, table: state.table, pk, row: payload } });
            }
            close();
            await loadRows(); renderMain();
          } catch (e) {
            alert((mode === 'insert' ? 'Insert' : 'Update') + ' failed: ' + e.message);
          }
        },
      },
    ],
  });
}

// ---------------- Structure view (schema management / DDL) ----------------
const COMMON_TYPES = [
  'text', 'varchar(255)', 'char(1)', 'integer', 'bigint', 'smallint', 'serial', 'bigserial',
  'numeric(10,2)', 'real', 'double precision', 'boolean', 'date', 'time',
  'timestamp', 'timestamptz', 'interval', 'uuid', 'json', 'jsonb', 'inet',
  'text[]', 'integer[]', 'uuid[]',
];
const CONTYPE_LABEL = {
  p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', t: 'TRIGGER',
};

// ----- Column display order (browser-local; the database is not touched) -----
// Postgres cannot reorder columns in place, so this is a per-table view preference.
// Use "Rebuild table in this order" to make it physical.
function colOrderKey(schema = state.schema, table = state.table) {
  return `pb.colorder.${schema}.${table}`;
}
function loadColOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(colOrderKey()));
    return Array.isArray(v) && v.length ? v : null;
  } catch (_) { return null; }
}
function saveColOrder(names) {
  try { localStorage.setItem(colOrderKey(), JSON.stringify(names)); } catch (_) { /* quota */ }
}
function clearColOrder() {
  try { localStorage.removeItem(colOrderKey()); } catch (_) { /* ignore */ }
}
// Known columns first, in the saved order; columns added since then keep their
// catalog order and land at the end (Array#sort is stable).
function applyColOrder(cols) {
  const order = loadColOrder();
  if (!order) return cols;
  const pos = new Map(order.map((n, i) => [n, i]));
  return [...cols].sort((a, b) => {
    const ai = pos.has(a.column_name) ? pos.get(a.column_name) : Infinity;
    const bi = pos.has(b.column_name) ? pos.get(b.column_name) : Infinity;
    return ai - bi;
  });
}
function moveColumn(from, to) {
  if (from == null || to == null || from === to) return;
  const cols = [...state.columns];
  if (from < 0 || from >= cols.length || to < 0 || to >= cols.length) return;
  const [m] = cols.splice(from, 1);
  cols.splice(to, 0, m);
  state.columns = cols;
  saveColOrder(cols.map(c => c.column_name));
  renderMain();
}

function fieldRow(labelText, inputEl, hint) {
  const f = el('div', { class: 'field' });
  f.appendChild(el('label', {}, labelText));
  f.appendChild(inputEl);
  if (hint) f.appendChild(el('div', { class: 'hint' }, hint));
  return f;
}

// A type <select> of the common Postgres types. When editing a column whose
// current type isn't in the list (enums, `timestamp with time zone`, …), that
// type is prepended and pre-selected so it's preserved and Save doesn't trigger
// an accidental re-cast.
function typeInput(value = '') {
  const input = el('select', { spellcheck: 'false' });
  const types = value && !COMMON_TYPES.includes(value) ? [value, ...COMMON_TYPES] : COMMON_TYPES;
  for (const t of types) {
    const o = el('option', { value: t }, t);
    if (t === value) o.selected = true;
    input.appendChild(o);
  }
  const box = el('div', {});
  box.appendChild(input);
  return { box, input };
}

async function loadStructure() {
  if (!state.table) { state.indexes = []; state.constraints = []; return; }
  const q = `schema=${encodeURIComponent(state.schema)}&table=${encodeURIComponent(state.table)}`;
  const [ix, cons] = await Promise.all([
    api(`/api/indexes?${q}`).catch(() => ({ indexes: [] })),
    api(`/api/constraints?${q}`).catch(() => ({ constraints: [] })),
  ]);
  state.indexes = ix.indexes || [];
  state.constraints = cons.constraints || [];
}

// Refresh app state after a DDL change, then re-render.
async function afterDdl({ reloadTables = false, table } = {}) {
  if (reloadTables) await loadTables();
  if (table !== undefined) state.table = table;
  const exists = state.table && state.tables.some(t => t.table_name === state.table);
  if (exists) {
    await loadColumns();
    await loadStructure();
  } else {
    state.table = null; state.columns = []; state.indexes = []; state.constraints = [];
  }
  renderSide(); renderMain();
}

function renderStructure(root) {
  const wrap = el('div', { class: 'struct-wrap' });
  root.appendChild(wrap);

  if (!state.table) {
    wrap.appendChild(el('div', { class: 'empty' }, 'Select a table from the left to manage it, or create a new one.'));
    const b = el('button', { class: 'primary', onclick: () => openCreateTable() }, '+ New table');
    wrap.appendChild(el('div', { style: 'text-align:center' }, b));
    return;
  }
  fillStructure(wrap);
}

async function fillStructure(wrap) {
  wrap.innerHTML = '';
  const tb = el('div', { class: 'toolbar' });
  tb.appendChild(el('span', { class: 'title' }, `${state.schema}.${state.table}`));
  tb.appendChild(el('button', { onclick: () => openCreateTable() }, '+ New table'));
  tb.appendChild(el('button', { onclick: () => openRenameTable() }, 'Rename'));
  tb.appendChild(el('button', { onclick: () => openTruncateTable() }, 'Truncate'));
  tb.appendChild(el('button', { class: 'danger', onclick: () => openDropTable() }, 'Drop table'));
  tb.appendChild(el('button', { onclick: () => afterDdl() }, 'Refresh'));
  wrap.appendChild(tb);

  try { await loadStructure(); } catch (_) { /* sections render empty */ }

  // ----- Columns -----
  const colSec = el('div', { class: 'struct-sec' });
  const customOrder = !!loadColOrder();
  const colHead = el('div', { class: 'struct-head' },
    el('h3', {}, `Columns (${state.columns.length})`),
    customOrder ? el('span', { class: 'muted-note', title: 'Display order differs from the database order' }, 'custom order') : null,
    el('button', { class: 'sm', onclick: () => openAddColumn() }, '+ Add column'),
    el('button', {
      class: 'sm', title: 'Physically rewrite the table in this column order',
      onclick: () => openRebuildTable(),
    }, 'Apply order to DB'),
  );
  if (customOrder) {
    colHead.appendChild(el('button', {
      class: 'sm', title: 'Restore the database column order',
      onclick: async () => { clearColOrder(); await afterDdl(); },
    }, 'Reset order'));
  }
  colSec.appendChild(colHead);
  colSec.appendChild(el('div', { class: 'hint' },
    'Drag a row (or use ↑ ↓) to reorder columns for display. This is saved in your browser only — use "Apply order to DB" to make it physical.'));

  const ct = el('table', { class: 'data' });
  ct.appendChild(el('thead', {}, el('tr', {},
    el('th', { class: 'drag-col' }, ''), el('th', {}, 'Name'), el('th', {}, 'Type'),
    el('th', {}, 'Nullable'), el('th', {}, 'Default'), el('th', {}, ''))));
  const cb = el('tbody');
  let dragFrom = null;
  state.columns.forEach((c, i) => {
    const isPk = (state.primaryKey || []).includes(c.column_name);
    // `draggable` is an enumerated attribute, not a boolean one: it must be the
    // string "true". Passing boolean true would emit draggable="" (i.e. "auto"),
    // which is not draggable.
    const tr = el('tr', { draggable: 'true', class: 'col-row' },
      el('td', { class: 'drag-col', title: 'Drag to reorder' }, '⠿'),
      el('td', {}, c.column_name + (isPk ? ' 🔑' : '')),
      el('td', {}, c.data_type === 'ARRAY' ? `${String(c.udt_name || '').replace(/^_/, '')}[]` : c.data_type),
      el('td', {}, c.is_nullable === 'YES' ? 'yes' : 'no'),
      el('td', {}, c.column_default == null ? '—' : String(c.column_default)),
      el('td', { class: 'actions' },
        el('button', { title: 'Move up', disabled: i === 0 || undefined, onclick: () => moveColumn(i, i - 1) }, '↑'),
        el('button', { title: 'Move down', disabled: i === state.columns.length - 1 || undefined, onclick: () => moveColumn(i, i + 1) }, '↓'),
        el('button', { onclick: () => openEditColumn(c) }, 'Edit'),
        el('button', { class: 'danger', onclick: () => dropColumn(c) }, 'Drop'),
      ),
    );
    tr.addEventListener('dragstart', (e) => {
      dragFrom = i;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires data to be set for a drag to start.
      try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) { /* ignore */ }
    });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); dragFrom = null; });
    tr.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; tr.classList.add('drag-over'); });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', (e) => {
      e.preventDefault();
      tr.classList.remove('drag-over');
      const from = dragFrom != null ? dragFrom : Number(e.dataTransfer.getData('text/plain'));
      moveColumn(from, i);
    });
    cb.appendChild(tr);
  });
  ct.appendChild(cb);
  colSec.appendChild(ct);
  wrap.appendChild(colSec);

  // ----- Indexes -----
  const ixSec = el('div', { class: 'struct-sec' });
  ixSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Indexes (${state.indexes.length})`),
    el('button', { class: 'sm', onclick: () => openCreateIndex() }, '+ Create index'),
  ));
  const it = el('table', { class: 'data' });
  it.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Name'), el('th', {}, 'Kind'), el('th', {}, 'Method'),
    el('th', {}, 'Definition'), el('th', {}, ''))));
  const ib = el('tbody');
  for (const ix of state.indexes) {
    const kind = ix.is_primary ? 'primary' : (ix.is_unique ? 'unique' : 'index');
    ib.appendChild(el('tr', {},
      el('td', {}, ix.name),
      el('td', {}, kind),
      el('td', {}, ix.method || ''),
      el('td', { class: 'mono', title: ix.definition }, ix.definition || ''),
      el('td', { class: 'actions' },
        ix.is_primary
          ? el('span', { class: 'muted-note', title: 'Backed by a constraint — drop the constraint instead' }, 'constraint')
          : el('button', { class: 'danger', onclick: () => dropIndex(ix) }, 'Drop'),
      ),
    ));
  }
  if (state.indexes.length === 0) ib.appendChild(el('tr', {}, el('td', { colspan: '5' }, el('span', { class: 'null' }, 'No indexes'))));
  it.appendChild(ib);
  ixSec.appendChild(it);
  wrap.appendChild(ixSec);

  // ----- Constraints -----
  const coSec = el('div', { class: 'struct-sec' });
  coSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Constraints (${state.constraints.length})`),
    el('button', { class: 'sm', onclick: () => openAddConstraint() }, '+ Add constraint'),
  ));
  const ot = el('table', { class: 'data' });
  ot.appendChild(el('thead', {}, el('tr', {},
    el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Definition'), el('th', {}, ''))));
  const ob = el('tbody');
  for (const con of state.constraints) {
    ob.appendChild(el('tr', {},
      el('td', {}, con.name),
      el('td', {}, CONTYPE_LABEL[con.type] || con.type),
      el('td', { class: 'mono', title: con.definition }, con.definition || ''),
      el('td', { class: 'actions' },
        el('button', { class: 'danger', onclick: () => dropConstraint(con) }, 'Drop')),
    ));
  }
  if (state.constraints.length === 0) ob.appendChild(el('tr', {}, el('td', { colspan: '4' }, el('span', { class: 'null' }, 'No constraints'))));
  ot.appendChild(ob);
  coSec.appendChild(ot);
  wrap.appendChild(coSec);
}

// ----- DDL actions -----
async function ddl(path, body) {
  return api('/api/ddl/' + path, { method: 'POST', body: { schema: state.schema, ...body } });
}

function openCreateTable() {
  const body = el('div');
  const nameInput = el('input', { type: 'text', placeholder: 'my_table', spellcheck: 'false' });
  body.appendChild(fieldRow('Table name', nameInput));

  const rows = [];
  const rowsWrap = el('div', { class: 'col-defs' });
  function addRow(preset = {}) {
    const row = el('div', { class: 'col-def' });
    const n = el('input', { type: 'text', placeholder: 'column_name', spellcheck: 'false' });
    n.value = preset.name || '';
    const { box: tBox, input: tIn } = typeInput(preset.type || '');
    const nn = el('input', { type: 'checkbox' });
    nn.checked = !!preset.notNull;
    const pk = el('input', { type: 'checkbox' });
    pk.checked = !!preset.primaryKey;
    const dv = el('input', { type: 'text', placeholder: 'default', spellcheck: 'false' });
    dv.value = preset.default || '';
    const del = el('button', { class: 'ghost sm danger', title: 'Remove column' }, icon('trash'));
    const entry = { name: n, type: tIn, notNull: nn, pk, def: dv, row };
    del.addEventListener('click', () => {
      const i = rows.indexOf(entry);
      if (i >= 0) rows.splice(i, 1);
      row.remove();
    });
    row.appendChild(n);
    row.appendChild(tBox);
    row.appendChild(dv);
    row.appendChild(el('label', { class: 'inline-cb', title: 'NOT NULL' }, nn, el('span', {}, 'NN')));
    row.appendChild(el('label', { class: 'inline-cb', title: 'PRIMARY KEY' }, pk, el('span', {}, 'PK')));
    row.appendChild(del);
    rows.push(entry);
    rowsWrap.appendChild(row);
  }
  body.appendChild(el('label', {}, 'Columns'));
  body.appendChild(rowsWrap);
  addRow({ name: 'id', type: 'bigserial', primaryKey: true, notNull: true });
  addRow({ name: '', type: 'text' });
  const addBtn = el('button', { class: 'sm', onclick: () => addRow({ type: 'text' }) }, '+ Add column');
  body.appendChild(addBtn);

  modal({
    title: 'Create table',
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create', class: 'primary',
        onClick: async (close) => {
          try {
            const table = nameInput.value.trim();
            if (!table) throw new Error('Table name is required');
            const columns = rows
              .filter(r => r.name.value.trim())
              .map(r => ({
                name: r.name.value.trim(),
                type: r.type.value.trim() || 'text',
                notNull: r.notNull.checked,
                primaryKey: r.pk.checked,
                default: r.def.value.trim(),
              }));
            if (columns.length === 0) throw new Error('At least one column is required');
            await ddl('table/create', { table, columns });
            close();
            await afterDdl({ reloadTables: true, table });
          } catch (e) { alert('Create table failed: ' + e.message); }
        },
      },
    ],
  });
}

function openRenameTable() {
  const input = el('input', { type: 'text', spellcheck: 'false' });
  input.value = state.table;
  const body = el('div', {}, fieldRow('New table name', input));
  modal({
    title: `Rename ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Rename', class: 'primary',
        onClick: async (close) => {
          try {
            const newName = input.value.trim();
            if (!newName) throw new Error('Name is required');
            await ddl('table/rename', { table: state.table, newName });
            close();
            await afterDdl({ reloadTables: true, table: newName });
          } catch (e) { alert('Rename failed: ' + e.message); }
        },
      },
    ],
  });
}

function openTruncateTable() {
  const cascade = el('input', { type: 'checkbox' });
  const restart = el('input', { type: 'checkbox' });
  const body = el('div', {},
    el('p', { class: 'hint' }, `This permanently deletes every row in ${state.schema}.${state.table}. The table itself is kept.`),
    el('label', { class: 'inline-cb' }, cascade, el('span', {}, 'CASCADE (also truncate tables referencing this one)')),
    el('label', { class: 'inline-cb' }, restart, el('span', {}, 'RESTART IDENTITY (reset sequences)')),
  );
  modal({
    title: `Truncate ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Truncate', class: 'danger',
        onClick: async (close) => {
          try {
            await ddl('table/truncate', { table: state.table, cascade: cascade.checked, restartIdentity: restart.checked });
            close();
            await afterDdl();
          } catch (e) { alert('Truncate failed: ' + e.message); }
        },
      },
    ],
  });
}

function openDropTable() {
  const cascade = el('input', { type: 'checkbox' });
  const confirmIn = el('input', { type: 'text', placeholder: state.table, spellcheck: 'false' });
  const body = el('div', {},
    el('p', { class: 'hint' }, `This permanently drops ${state.schema}.${state.table} and all its data. Type the table name to confirm.`),
    confirmIn,
    el('label', { class: 'inline-cb' }, cascade, el('span', {}, 'CASCADE (also drop dependent objects)')),
  );
  modal({
    title: `Drop ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Drop table', class: 'danger',
        onClick: async (close) => {
          try {
            if (confirmIn.value.trim() !== state.table) throw new Error('Table name does not match');
            await ddl('table/drop', { table: state.table, cascade: cascade.checked });
            close();
            await afterDdl({ reloadTables: true, table: null });
          } catch (e) { alert('Drop failed: ' + e.message); }
        },
      },
    ],
  });
}

function openRebuildTable() {
  const order = state.columns.map(c => c.column_name);
  const confirmIn = el('input', { type: 'text', placeholder: state.table, spellcheck: 'false' });
  const orderBox = el('div', { class: 'mono rebuild-order' },
    order.map((n, i) => `${String(i + 1).padStart(2, ' ')}. ${n}`).join('\n'));
  const body = el('div', {},
    el('p', { class: 'hint' }, 'Postgres cannot reorder columns in place. This recreates the table in the order below and copies every row — all inside one transaction, so it rolls back completely if anything fails.'),
    el('label', {}, 'New column order'),
    orderBox,
    el('p', { class: 'hint' }, 'Preserved: types, NOT NULL, defaults, identity/serial values, PK / unique / check / FK, incoming FKs from other tables, indexes and triggers.'),
    el('p', { class: 'hint' }, 'NOT preserved: grants, RLS policies, comments. Refused if any view depends on this table, or if it uses inheritance/partitioning.'),
    el('p', { class: 'hint' }, 'The table is locked for the duration. Take a backup first. Type the table name to confirm.'),
    confirmIn,
  );
  modal({
    title: `Rebuild ${state.table} in this order`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Rebuild table', class: 'danger',
        onClick: async (close) => {
          try {
            if (confirmIn.value.trim() !== state.table) throw new Error('Table name does not match');
            await ddl('table/rebuild', { table: state.table, columns: order });
            // Physical order now matches, so the local override is redundant.
            clearColOrder();
            close();
            await afterDdl();
          } catch (e) { alert('Rebuild failed: ' + e.message); }
        },
      },
    ],
  });
}

function openAddColumn() {
  const name = el('input', { type: 'text', placeholder: 'column_name', spellcheck: 'false' });
  const { box: tBox, input: tIn } = typeInput('text');
  const notNull = el('input', { type: 'checkbox' });
  const def = el('input', { type: 'text', placeholder: "e.g. now()  |  0  |  'x'", spellcheck: 'false' });
  const body = el('div', {},
    fieldRow('Name', name),
    fieldRow('Type', tBox),
    fieldRow('Default expression', def, 'Raw SQL, left blank for none.'),
    el('label', { class: 'inline-cb' }, notNull, el('span', {}, 'NOT NULL')),
  );
  modal({
    title: `Add column to ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Add', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            await ddl('column/add', {
              table: state.table, name: name.value.trim(), type: tIn.value.trim() || 'text',
              notNull: notNull.checked, default: def.value.trim(),
            });
            close();
            await afterDdl();
          } catch (e) { alert('Add column failed: ' + e.message); }
        },
      },
    ],
  });
}

function openEditColumn(c) {
  const name = el('input', { type: 'text', spellcheck: 'false' });
  name.value = c.column_name;
  const curType = c.data_type === 'ARRAY' ? `${String(c.udt_name || '').replace(/^_/, '')}[]` : c.data_type;
  const { box: tBox, input: tIn } = typeInput(curType);
  const notNull = el('input', { type: 'checkbox' });
  notNull.checked = c.is_nullable !== 'YES';
  const def = el('input', { type: 'text', spellcheck: 'false' });
  def.value = c.column_default == null ? '' : String(c.column_default);
  const dropDef = el('input', { type: 'checkbox' });
  dropDef.addEventListener('change', () => { def.disabled = dropDef.checked; });

  const body = el('div', {},
    fieldRow('Name', name),
    fieldRow('Type', tBox, 'Changing type re-casts existing values (USING col::type).'),
    fieldRow('Default expression', def),
    el('label', { class: 'inline-cb' }, dropDef, el('span', {}, 'Drop default')),
    el('label', { class: 'inline-cb' }, notNull, el('span', {}, 'NOT NULL')),
  );
  modal({
    title: `Edit column ${c.column_name}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Save', class: 'primary',
        onClick: async (close) => {
          try {
            const payload = { table: state.table, column: c.column_name };
            const newName = name.value.trim();
            if (newName && newName !== c.column_name) payload.newName = newName;
            const newType = tIn.value.trim();
            if (newType && newType !== curType) payload.type = newType;
            const wasNotNull = c.is_nullable !== 'YES';
            if (notNull.checked !== wasNotNull) payload.notNull = notNull.checked;
            if (dropDef.checked) payload.dropDefault = true;
            else if (def.value.trim() && def.value.trim() !== String(c.column_default ?? '')) payload.default = def.value.trim();
            await ddl('column/alter', payload);
            close();
            await afterDdl();
          } catch (e) { alert('Alter column failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropColumn(c) {
  if (!confirm(`Drop column "${c.column_name}" and all its data?`)) return;
  try {
    await ddl('column/drop', { table: state.table, column: c.column_name });
    await afterDdl();
  } catch (e) {
    if (/depend|cannot be dropped/i.test(e.message) && confirm(`${e.message}\n\nRetry with CASCADE (drops dependent objects)?`)) {
      try { await ddl('column/drop', { table: state.table, column: c.column_name, cascade: true }); await afterDdl(); }
      catch (e2) { alert('Drop column failed: ' + e2.message); }
    } else { alert('Drop column failed: ' + e.message); }
  }
}

function openCreateIndex() {
  const name = el('input', { type: 'text', spellcheck: 'false' });
  name.value = `${state.table}_idx`;
  const colSel = el('select', { multiple: true, size: String(Math.min(8, Math.max(3, state.columns.length))) });
  for (const c of state.columns) colSel.appendChild(el('option', { value: c.column_name }, c.column_name));
  const unique = el('input', { type: 'checkbox' });
  const method = el('select');
  for (const m of ['btree', 'hash', 'gist', 'gin', 'spgist', 'brin']) method.appendChild(el('option', { value: m }, m));

  const body = el('div', {},
    fieldRow('Index name', name),
    fieldRow('Columns', colSel, 'Ctrl/Cmd-click to select multiple (order matters).'),
    fieldRow('Method', method),
    el('label', { class: 'inline-cb' }, unique, el('span', {}, 'UNIQUE')),
  );
  modal({
    title: `Create index on ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create', class: 'primary',
        onClick: async (close) => {
          try {
            const columns = [...colSel.selectedOptions].map(o => o.value);
            if (columns.length === 0) throw new Error('Select at least one column');
            if (!name.value.trim()) throw new Error('Index name is required');
            await ddl('index/create', {
              table: state.table, name: name.value.trim(), columns,
              unique: unique.checked, method: method.value,
            });
            close();
            await afterDdl();
          } catch (e) { alert('Create index failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropIndex(ix) {
  if (!confirm(`Drop index "${ix.name}"?`)) return;
  try { await ddl('index/drop', { name: ix.name }); await afterDdl(); }
  catch (e) { alert('Drop index failed: ' + e.message); }
}

function openAddConstraint() {
  const name = el('input', { type: 'text', spellcheck: 'false' });
  let nameTouched = false;
  name.addEventListener('input', () => { nameTouched = true; });

  const typeSel = el('select');
  for (const [v, l] of [['unique', 'UNIQUE'], ['pk', 'PRIMARY KEY'], ['check', 'CHECK'], ['fk', 'FOREIGN KEY']]) {
    typeSel.appendChild(el('option', { value: v }, l));
  }
  const colSel = el('select', { multiple: true, size: '5' });
  for (const c of state.columns) colSel.appendChild(el('option', { value: c.column_name }, c.column_name));
  const expr = el('textarea', { spellcheck: 'false', placeholder: 'price > 0' });

  const refSchemaSel = el('select');
  const refTableSel = el('select');
  const refColSel = el('select', { multiple: true, size: '5' });
  const onDel = el('select'), onUpd = el('select');
  for (const a of ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']) {
    onDel.appendChild(el('option', { value: a }, a));
    onUpd.appendChild(el('option', { value: a }, a));
  }
  for (const s of state.schemas) {
    const o = el('option', { value: s }, s);
    if (s === state.schema) o.selected = true;
    refSchemaSel.appendChild(o);
  }
  async function loadRefCols() {
    refColSel.innerHTML = '';
    if (!refTableSel.value) return;
    try {
      const r = await api(`/api/columns?schema=${encodeURIComponent(refSchemaSel.value)}&table=${encodeURIComponent(refTableSel.value)}`);
      for (const c of r.columns) refColSel.appendChild(el('option', { value: c.column_name }, c.column_name));
      for (const o of refColSel.options) if ((r.primaryKey || []).includes(o.value)) o.selected = true;
    } catch (_) { /* leave empty */ }
  }
  async function loadRefTables() {
    refTableSel.innerHTML = ''; refColSel.innerHTML = '';
    try {
      const r = await api(`/api/tables?schema=${encodeURIComponent(refSchemaSel.value)}`);
      for (const t of r.tables) refTableSel.appendChild(el('option', { value: t.table_name }, t.table_name));
      await loadRefCols();
    } catch (_) { /* leave empty */ }
  }
  refSchemaSel.addEventListener('change', loadRefTables);
  refTableSel.addEventListener('change', loadRefCols);

  const colField = fieldRow('Columns', colSel, 'Ctrl/Cmd-click for multiple (order matters).');
  const exprField = fieldRow('Check expression', expr);
  const fkWrap = el('div', {},
    fieldRow('References schema', refSchemaSel),
    fieldRow('References table', refTableSel),
    fieldRow('References columns', refColSel),
    fieldRow('ON DELETE', onDel),
    fieldRow('ON UPDATE', onUpd),
  );
  function sync() {
    const t = typeSel.value;
    colField.style.display = t === 'check' ? 'none' : '';
    exprField.style.display = t === 'check' ? '' : 'none';
    fkWrap.style.display = t === 'fk' ? '' : 'none';
    if (!nameTouched) name.value = `${state.table}_${t}`;
    if (t === 'fk' && refTableSel.options.length === 0) loadRefTables();
  }
  typeSel.addEventListener('change', sync);

  const body = el('div', {}, fieldRow('Name', name), fieldRow('Type', typeSel), colField, exprField, fkWrap);
  sync();

  modal({
    title: `Add constraint to ${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Add', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            const type = typeSel.value;
            const payload = { table: state.table, name: name.value.trim(), type };
            if (type === 'check') {
              if (!expr.value.trim()) throw new Error('Check expression is required');
              payload.expression = expr.value.trim();
            } else {
              payload.columns = [...colSel.selectedOptions].map(o => o.value);
              if (payload.columns.length === 0) throw new Error('Select at least one column');
            }
            if (type === 'fk') {
              payload.refSchema = refSchemaSel.value;
              payload.refTable = refTableSel.value;
              payload.refColumns = [...refColSel.selectedOptions].map(o => o.value);
              payload.onDelete = onDel.value;
              payload.onUpdate = onUpd.value;
              if (!payload.refTable) throw new Error('Choose a referenced table');
              if (payload.refColumns.length === 0) throw new Error('Choose referenced column(s)');
            }
            await ddl('constraint/add', payload);
            close();
            await afterDdl();
          } catch (e) { alert('Add constraint failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropConstraint(con) {
  if (!confirm(`Drop constraint "${con.name}"?\n\n${con.definition || ''}`)) return;
  try { await ddl('constraint/drop', { table: state.table, name: con.name }); await afterDdl(); }
  catch (e) {
    if (/depend/i.test(e.message) && confirm(`${e.message}\n\nRetry with CASCADE?`)) {
      try { await ddl('constraint/drop', { table: state.table, name: con.name, cascade: true }); await afterDdl(); }
      catch (e2) { alert('Drop constraint failed: ' + e2.message); }
    } else { alert('Drop constraint failed: ' + e.message); }
  }
}

// ---------------- Database view (schemas / views / functions / roles) ----------------
async function rawDdl(path, body) {
  return api('/api/ddl/' + path, { method: 'POST', body });
}

async function loadDbObjects() {
  const q = `schema=${encodeURIComponent(state.schema)}`;
  const [sc, vw, fn, rl] = await Promise.all([
    api('/api/db/schemas').catch(() => ({ schemas: [] })),
    api(`/api/db/views?${q}`).catch(() => ({ views: [] })),
    api(`/api/db/functions?${q}`).catch(() => ({ functions: [] })),
    api('/api/db/roles').catch(() => ({ roles: [] })),
  ]);
  state.dbSchemas = sc.schemas || [];
  state.views = vw.views || [];
  state.functions = fn.functions || [];
  state.roles = rl.roles || [];
}

// Re-sync after a database-level change, then re-render.
async function afterDbDdl({ reloadSchemas = false } = {}) {
  if (reloadSchemas) {
    try {
      const r = await api('/api/schemas');
      state.schemas = r.schemas || [];
      if (!state.schemas.includes(state.schema)) {
        state.schema = state.schemas[0] || 'public';
        state.table = null; state.columns = [];
        await loadTables();
      }
    } catch (_) { /* keep current */ }
  }
  renderSide(); renderMain();
}

function renderDatabase(root) {
  const wrap = el('div', { class: 'struct-wrap' });
  root.appendChild(wrap);
  fillDatabase(wrap);
}

function objTable(headers, rows) {
  const t = el('table', { class: 'data' });
  t.appendChild(el('thead', {}, el('tr', {}, ...headers.map(h => el('th', {}, h)))));
  const tb = el('tbody');
  for (const r of rows) tb.appendChild(r);
  if (rows.length === 0) {
    tb.appendChild(el('tr', {}, el('td', { colspan: String(headers.length) }, el('span', { class: 'null' }, 'None'))));
  }
  t.appendChild(tb);
  return t;
}

async function fillDatabase(wrap) {
  wrap.innerHTML = '';
  const tb = el('div', { class: 'toolbar' });
  tb.appendChild(el('span', { class: 'title' }, `Database — ${state.info ? state.info.db : ''}`));
  tb.appendChild(el('button', { onclick: () => openExportDb() }, '⭳ Export'));
  tb.appendChild(el('button', { onclick: () => openImportDb() }, '⭱ Import'));
  tb.appendChild(el('button', { onclick: () => fillDatabase(wrap) }, 'Refresh'));
  wrap.appendChild(tb);

  try { await loadDbObjects(); } catch (_) { /* sections render empty */ }

  // ----- Schemas -----
  const sSec = el('div', { class: 'struct-sec' });
  sSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Schemas (${state.dbSchemas.length})`),
    el('button', { class: 'sm', onclick: () => openCreateSchema() }, '+ Create schema'),
  ));
  sSec.appendChild(objTable(['Name', 'Owner', ''], state.dbSchemas.map(s => el('tr', {},
    el('td', {}, s.name),
    el('td', {}, s.owner || ''),
    el('td', { class: 'actions' },
      el('button', { onclick: () => openRenameSchema(s) }, 'Rename'),
      el('button', { class: 'danger', onclick: () => dropSchema(s) }, 'Drop'),
    ),
  ))));
  wrap.appendChild(sSec);

  // ----- Views -----
  const vSec = el('div', { class: 'struct-sec' });
  vSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Views in ${state.schema} (${state.views.length})`),
    el('button', { class: 'sm', onclick: () => openCreateView() }, '+ Create view'),
  ));
  vSec.appendChild(objTable(['Name', 'Kind', 'Owner', 'Definition', ''], state.views.map(v => el('tr', {},
    el('td', {}, v.name),
    el('td', {}, v.kind === 'm' ? 'materialized' : 'view'),
    el('td', {}, v.owner || ''),
    el('td', { class: 'mono', title: v.definition }, (v.definition || '').replace(/\s+/g, ' ').slice(0, 120)),
    el('td', { class: 'actions' },
      el('button', { onclick: () => showSource(`${v.name} — definition`, v.definition || '') }, 'Source'),
      v.kind === 'm' ? el('button', { onclick: () => refreshView(v) }, 'Refresh') : null,
      el('button', { class: 'danger', onclick: () => dropView(v) }, 'Drop'),
    ),
  ))));
  wrap.appendChild(vSec);

  // ----- Functions -----
  const fSec = el('div', { class: 'struct-sec' });
  fSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Functions in ${state.schema} (${state.functions.length})`),
    el('button', { class: 'sm', onclick: () => openCreateFunction() }, '+ Create function'),
  ));
  fSec.appendChild(objTable(['Name', 'Arguments', 'Returns', 'Lang', ''], state.functions.map(f => el('tr', {},
    el('td', {}, f.name),
    el('td', { class: 'mono', title: f.args }, f.args || ''),
    el('td', { class: 'mono' }, f.kind === 'p' ? 'procedure' : (f.returns || '')),
    el('td', {}, f.language || ''),
    el('td', { class: 'actions' },
      el('button', { onclick: () => showFunctionSource(f) }, 'Source'),
      el('button', { class: 'danger', onclick: () => dropFunction(f) }, 'Drop'),
    ),
  ))));
  wrap.appendChild(fSec);

  // ----- Roles -----
  const rSec = el('div', { class: 'struct-sec' });
  rSec.appendChild(el('div', { class: 'struct-head' },
    el('h3', {}, `Roles (${state.roles.length})`),
    el('button', { class: 'sm', onclick: () => openCreateRole() }, '+ Create role'),
  ));
  rSec.appendChild(objTable(['Name', 'Attributes', 'Conn limit', ''], state.roles.map(r => el('tr', {},
    el('td', {}, r.name),
    el('td', { class: 'muted-note' }, roleAttrs(r) || '—'),
    el('td', {}, r.connlimit === -1 ? '∞' : String(r.connlimit)),
    el('td', { class: 'actions' },
      el('button', { onclick: () => openEditRole(r) }, 'Edit'),
      el('button', { class: 'danger', onclick: () => dropRole(r) }, 'Drop'),
    ),
  ))));
  wrap.appendChild(rSec);
}

function roleAttrs(r) {
  const a = [];
  if (r.superuser) a.push('SUPERUSER');
  if (r.createdb) a.push('CREATEDB');
  if (r.createrole) a.push('CREATEROLE');
  if (r.login) a.push('LOGIN');
  if (r.replication) a.push('REPLICATION');
  if (!r.inherit) a.push('NOINHERIT');
  return a.join(', ');
}

function showSource(title, text) {
  const ta = el('textarea', { spellcheck: 'false', readonly: true, style: 'min-height:320px' });
  ta.value = text;
  modal({ title, body: el('div', {}, ta), actions: [{ label: 'Close', onClick: (close) => close() }] });
}

async function showFunctionSource(f) {
  try {
    const r = await api(`/api/db/function-def?oid=${encodeURIComponent(f.oid)}`);
    showSource(`${f.name}(${f.args || ''})`, r.definition || '(source unavailable)');
  } catch (e) { alert('Could not load source: ' + e.message); }
}

// ----- Schema actions -----
function openCreateSchema() {
  const name = el('input', { type: 'text', placeholder: 'analytics', spellcheck: 'false' });
  modal({
    title: 'Create schema',
    body: el('div', {}, fieldRow('Schema name', name)),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            await rawDdl('schema/create', { name: name.value.trim() });
            close();
            await afterDbDdl({ reloadSchemas: true });
          } catch (e) { alert('Create schema failed: ' + e.message); }
        },
      },
    ],
  });
}

function openRenameSchema(s) {
  const name = el('input', { type: 'text', spellcheck: 'false' });
  name.value = s.name;
  modal({
    title: `Rename schema ${s.name}`,
    body: el('div', {}, fieldRow('New name', name)),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Rename', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            await rawDdl('schema/rename', { name: s.name, newName: name.value.trim() });
            if (state.schema === s.name) state.schema = name.value.trim();
            close();
            await afterDbDdl({ reloadSchemas: true });
          } catch (e) { alert('Rename schema failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropSchema(s) {
  if (!confirm(`Drop schema "${s.name}"?\n\nThis fails unless the schema is empty; you will be offered CASCADE.`)) return;
  try {
    await rawDdl('schema/drop', { name: s.name });
    await afterDbDdl({ reloadSchemas: true });
  } catch (e) {
    if (confirm(`${e.message}\n\nRetry with CASCADE? This drops every object inside "${s.name}".`)) {
      try { await rawDdl('schema/drop', { name: s.name, cascade: true }); await afterDbDdl({ reloadSchemas: true }); }
      catch (e2) { alert('Drop schema failed: ' + e2.message); }
    }
  }
}

// ----- View actions -----
function openCreateView() {
  const name = el('input', { type: 'text', placeholder: 'active_users', spellcheck: 'false' });
  const sql = el('textarea', { spellcheck: 'false', placeholder: 'SELECT * FROM users WHERE active', style: 'min-height:160px' });
  const mat = el('input', { type: 'checkbox' });
  const rep = el('input', { type: 'checkbox' });
  modal({
    title: `Create view in ${state.schema}`,
    body: el('div', {},
      fieldRow('View name', name),
      fieldRow('SELECT statement', sql, 'A single SELECT; no trailing semicolon needed.'),
      el('label', { class: 'inline-cb' }, mat, el('span', {}, 'MATERIALIZED')),
      el('label', { class: 'inline-cb' }, rep, el('span', {}, 'OR REPLACE (regular views only)')),
    ),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            if (!sql.value.trim()) throw new Error('SELECT statement is required');
            await ddl('view/create', {
              name: name.value.trim(), sql: sql.value,
              materialized: mat.checked, replace: rep.checked,
            });
            close();
            await afterDbDdl();
          } catch (e) { alert('Create view failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropView(v) {
  if (!confirm(`Drop ${v.kind === 'm' ? 'materialized view' : 'view'} "${v.name}"?`)) return;
  const materialized = v.kind === 'm';
  try {
    await ddl('view/drop', { name: v.name, materialized });
    await afterDbDdl();
  } catch (e) {
    if (/depend/i.test(e.message) && confirm(`${e.message}\n\nRetry with CASCADE?`)) {
      try { await ddl('view/drop', { name: v.name, materialized, cascade: true }); await afterDbDdl(); }
      catch (e2) { alert('Drop view failed: ' + e2.message); }
    } else { alert('Drop view failed: ' + e.message); }
  }
}

async function refreshView(v) {
  try { await ddl('view/refresh', { name: v.name }); await afterDbDdl(); }
  catch (e) { alert('Refresh failed: ' + e.message); }
}

// ----- Function actions -----
function openCreateFunction() {
  const sql = el('textarea', { spellcheck: 'false', style: 'min-height:260px' });
  sql.value = `CREATE OR REPLACE FUNCTION ${state.schema}.my_func(a integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN a * 2;\nEND;\n$$;`;
  modal({
    title: 'Create function / procedure',
    body: el('div', {},
      fieldRow('Statement', sql, 'The full CREATE FUNCTION or CREATE PROCEDURE statement.'),
    ),
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Run', class: 'primary',
        onClick: async (close) => {
          try {
            await rawDdl('function/create', { sql: sql.value });
            close();
            await afterDbDdl();
          } catch (e) { alert('Create function failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropFunction(f) {
  if (!confirm(`Drop ${f.kind === 'p' ? 'procedure' : 'function'} ${f.name}(${f.args || ''})?`)) return;
  const payload = { name: f.name, args: f.args || '', procedure: f.kind === 'p' };
  try { await ddl('function/drop', payload); await afterDbDdl(); }
  catch (e) {
    if (/depend/i.test(e.message) && confirm(`${e.message}\n\nRetry with CASCADE?`)) {
      try { await ddl('function/drop', { ...payload, cascade: true }); await afterDbDdl(); }
      catch (e2) { alert('Drop function failed: ' + e2.message); }
    } else { alert('Drop function failed: ' + e.message); }
  }
}

// ----- Role actions -----
function roleFormFields(preset = {}) {
  const login = el('input', { type: 'checkbox' }); login.checked = !!preset.login;
  const superuser = el('input', { type: 'checkbox' }); superuser.checked = !!preset.superuser;
  const createdb = el('input', { type: 'checkbox' }); createdb.checked = !!preset.createdb;
  const createrole = el('input', { type: 'checkbox' }); createrole.checked = !!preset.createrole;
  const inherit = el('input', { type: 'checkbox' }); inherit.checked = preset.inherit !== false;
  const password = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'leave blank to keep unchanged' });
  const connlimit = el('input', { type: 'number', placeholder: '-1 (unlimited)' });
  if (preset.connlimit !== undefined && preset.connlimit !== null) connlimit.value = String(preset.connlimit);
  const body = el('div', {},
    fieldRow('Password', password),
    fieldRow('Connection limit', connlimit),
    el('label', { class: 'inline-cb' }, login, el('span', {}, 'LOGIN')),
    el('label', { class: 'inline-cb' }, superuser, el('span', {}, 'SUPERUSER')),
    el('label', { class: 'inline-cb' }, createdb, el('span', {}, 'CREATEDB')),
    el('label', { class: 'inline-cb' }, createrole, el('span', {}, 'CREATEROLE')),
    el('label', { class: 'inline-cb' }, inherit, el('span', {}, 'INHERIT')),
  );
  const collect = () => {
    const o = {
      login: login.checked, superuser: superuser.checked, createdb: createdb.checked,
      createrole: createrole.checked, inherit: inherit.checked,
    };
    if (password.value) o.password = password.value;
    if (connlimit.value !== '') o.connlimit = Number(connlimit.value);
    return o;
  };
  return { body, collect };
}

function openCreateRole() {
  const name = el('input', { type: 'text', placeholder: 'app_user', spellcheck: 'false' });
  const { body: optBody, collect } = roleFormFields({ login: true, inherit: true });
  const body = el('div', {}, fieldRow('Role name', name), optBody);
  modal({
    title: 'Create role',
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Create', class: 'primary',
        onClick: async (close) => {
          try {
            if (!name.value.trim()) throw new Error('Name is required');
            await rawDdl('role/create', { name: name.value.trim(), ...collect() });
            close();
            await afterDbDdl();
          } catch (e) { alert('Create role failed: ' + e.message); }
        },
      },
    ],
  });
}

function openEditRole(r) {
  const { body, collect } = roleFormFields(r);
  modal({
    title: `Edit role ${r.name}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Save', class: 'primary',
        onClick: async (close) => {
          try {
            await rawDdl('role/alter', { name: r.name, ...collect() });
            close();
            await afterDbDdl();
          } catch (e) { alert('Alter role failed: ' + e.message); }
        },
      },
    ],
  });
}

async function dropRole(r) {
  if (!confirm(`Drop role "${r.name}"?\n\nThis fails if the role still owns objects.`)) return;
  try { await rawDdl('role/drop', { name: r.name }); await afterDbDdl(); }
  catch (e) { alert('Drop role failed: ' + e.message); }
}

// ---------------- Tabular export (CSV / JSON) ----------------
// Values arrive here already JSON-parsed: timestamps are ISO strings, arrays and
// json/jsonb are JS arrays/objects, NULL is null.
function exportCellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function toCSV(rows, cols) {
  const esc = (s) => /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const head = cols.map(c => esc(String(c))).join(',');
  const body = rows.map(r => cols.map(c => esc(exportCellText(r[c]))).join(',')).join('\r\n');
  return '﻿' + head + (body ? '\r\n' + body : ''); // BOM so Excel reads UTF-8
}
function toJSON(rows, cols) {
  return JSON.stringify(rows.map(r => {
    const o = {};
    for (const c of cols) o[c] = r[c] === undefined ? null : r[c];
    return o;
  }), null, 2);
}
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportRows(rows, cols, format, baseName) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (format === 'json') downloadText(`${baseName}-${stamp}.json`, toJSON(rows, cols), 'application/json');
  else downloadText(`${baseName}-${stamp}.csv`, toCSV(rows, cols), 'text/csv');
}

// Data-view export: selection (across pages), current page, or all matching rows.
function openExportRows() {
  const cols = state.columns.map(c => c.column_name);
  const selCount = state.selection.size;
  const hasFilter = state.filter && Object.keys(state.filter).length > 0;
  const hasPk = state.primaryKey.length > 0;

  const format = el('select');
  format.appendChild(el('option', { value: 'csv' }, 'CSV'));
  format.appendChild(el('option', { value: 'json' }, 'JSON'));

  const scope = el('select');
  if (selCount > 0 && hasPk) scope.appendChild(el('option', { value: 'selected' }, `Selected rows (${selCount})`));
  scope.appendChild(el('option', { value: 'page' }, `This page (${state.rows.length})`));
  scope.appendChild(el('option', { value: 'all' }, `All rows${hasFilter ? ' matching filter' : ''} (${state.total})`));

  const status = el('div', { class: 'hint' });
  const body = el('div', {},
    fieldRow('Format', format),
    fieldRow('Rows', scope),
    status,
  );
  modal({
    title: `Export ${state.schema}.${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Export', class: 'primary',
        onClick: async (close) => {
          const fmt = format.value;
          try {
            let rows;
            if (scope.value === 'page') {
              rows = state.rows;
            } else {
              status.textContent = 'Fetching rows…';
              const body = {
                schema: state.schema, table: state.table,
                orderBy: state.orderBy || undefined, orderDir: state.orderDir,
              };
              if (scope.value === 'selected') body.pks = [...state.selection].map(k => JSON.parse(k));
              else if (hasFilter) body.where = state.filter;
              const r = await api('/api/export-rows', { method: 'POST', body });
              rows = r.rows;
              if (r.truncated) alert(`Export capped at ${rows.length} rows — the result set is larger.`);
            }
            exportRows(rows, cols, fmt, `${state.schema}.${state.table}`);
            close();
          } catch (e) { status.textContent = ''; alert('Export failed: ' + (e.detail || e.message)); }
        },
      },
    ],
  });
}

// ---------------- Full database export / import ----------------
function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function openExportDb() {
  const format = el('select');
  for (const [v, l] of [['custom', 'Custom (compressed — restore with pg_restore)'], ['plain', 'Plain SQL (.sql — restore with psql)'], ['tar', 'Tar archive']]) {
    format.appendChild(el('option', { value: v }, l));
  }
  const scope = el('select');
  for (const [v, l] of [['all', 'Schema + data (everything)'], ['schema', 'Schema only'], ['data', 'Data only']]) {
    scope.appendChild(el('option', { value: v }, l));
  }
  const portable = el('input', { type: 'checkbox' }); portable.checked = true;
  const status = el('div', { class: 'hint' });

  const body = el('div', {},
    fieldRow('Format', format),
    fieldRow('Contents', scope),
    el('label', { class: 'inline-cb' }, portable, el('span', {}, 'Portable (skip ownership & grants — restores cleanly into any role)')),
    el('p', { class: 'hint' }, `Runs pg_dump on the server for “${state.info ? state.info.db : ''}”, then downloads the result. Large databases stream straight to disk.`),
    status,
  );

  modal({
    title: 'Export database',
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Export', class: 'primary',
        onClick: async (close) => {
          status.textContent = 'Running pg_dump…';
          try {
            const j = await api('/api/db/export', {
              method: 'POST',
              body: { format: format.value, scope: scope.value === 'all' ? undefined : scope.value, portable: portable.checked },
            });
            status.textContent = `Ready — ${fmtBytes(j.bytes)}. Downloading…`;
            // Anchor download streams to disk (no browser-memory blob).
            const a = el('a', { href: `/api/db/export/download/${encodeURIComponent(j.id)}`, download: j.filename });
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(close, 800);
          } catch (e) {
            status.textContent = '';
            alert('Export failed: ' + (e.detail || e.message));
          }
        },
      },
    ],
  });
}

function openImportDb() {
  const fileInput = el('input', { type: 'file' });
  const clean = el('input', { type: 'checkbox' }); clean.checked = true;
  const stop = el('input', { type: 'checkbox' }); stop.checked = true;
  const confirmIn = el('input', { type: 'text', placeholder: 'IMPORT', spellcheck: 'false' });
  const status = el('div', { class: 'hint' });
  const output = el('textarea', { spellcheck: 'false', readonly: true, style: 'min-height:120px; display:none' });

  const body = el('div', {},
    el('p', { class: 'hint danger-text' }, `This restores a dump into “${state.info ? state.info.db : ''}” and can overwrite or drop existing objects. Take a backup (Export) first.`),
    fieldRow('Dump file', fileInput, 'Custom/tar dumps use pg_restore; .sql files use psql. Format is auto-detected.'),
    el('label', { class: 'inline-cb' }, clean, el('span', {}, 'Clean first — drop existing objects before recreating (custom/tar only)')),
    el('label', { class: 'inline-cb' }, stop, el('span', {}, 'Stop on first error')),
    fieldRow('Type IMPORT to confirm', confirmIn),
    status,
    output,
  );

  modal({
    title: 'Import database',
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Import', class: 'danger',
        onClick: async (close) => {
          const f = fileInput.files && fileInput.files[0];
          if (!f) { alert('Choose a dump file'); return; }
          if (confirmIn.value.trim() !== 'IMPORT') { alert('Type IMPORT to confirm'); return; }
          status.textContent = `Uploading & restoring ${f.name} (${fmtBytes(f.size)})…`;
          output.style.display = 'none';
          try {
            const qs = new URLSearchParams({ clean: clean.checked ? '1' : '0', stop: stop.checked ? '1' : '0' });
            const r = await fetch('/api/db/import?' + qs.toString(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: f,
            });
            const j = await r.json().catch(() => ({}));
            const log = [j.stdout, j.stderr].filter(Boolean).join('\n\n');
            if (log) { output.value = log; output.style.display = ''; }
            if (r.ok && j.ok) {
              status.textContent = `Done via ${j.tool} (${j.format}). Exit code 0.`;
              await afterDbDdl({ reloadSchemas: true });
            } else {
              status.textContent = `Failed${j.tool ? ' via ' + j.tool : ''}${j.code != null ? ` (exit ${j.code})` : ''}.`;
              if (!log) alert('Import failed: ' + (j.detail || j.error || r.statusText));
            }
          } catch (e) {
            status.textContent = '';
            alert('Import failed: ' + e.message);
          }
        },
      },
    ],
  });
}

// ---------------- Map view (schema diagram) ----------------
async function renderMap(root) {
  const wrap = el('div', { class: 'map-wrap' });
  const head = el('div', { class: 'map-head' });
  head.appendChild(el('h2', { style: 'font-size:14px;text-transform:uppercase;letter-spacing:1px;margin:0' }, `Schema map · ${state.schema}`));
  const status = el('span', { class: 'map-status' }, 'Loading…');
  head.appendChild(status);
  const relayout = el('button', { class: 'ghost' }, 'Relayout');
  const zoomIn = el('button', { class: 'ghost' }, '+');
  const zoomOut = el('button', { class: 'ghost' }, '−');
  const zoomReset = el('button', { class: 'ghost' }, '100%');
  head.appendChild(relayout); head.appendChild(zoomOut); head.appendChild(zoomReset); head.appendChild(zoomIn);
  wrap.appendChild(head);
  const canvas = el('div', { class: 'map-canvas' });
  wrap.appendChild(canvas);
  root.appendChild(wrap);

  let data;
  try {
    data = await api(`/api/schema-map?schema=${encodeURIComponent(state.schema)}`);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    return;
  }
  if (!data.tables.length) { status.textContent = 'No tables in this schema.'; return; }
  status.textContent = `${data.tables.length} tables · ${data.edges.length} relationships`;

  // ---- layout ----
  const tableByName = new Map(data.tables.map(t => [t.name, t]));
  const positions = new Map(); // name -> {x,y,w,h}
  function autoLayout() {
    const n = data.tables.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
    const colW = 260, rowH = 0; // rowH dynamic per row
    const gapX = 60, gapY = 50;
    const rowHeights = [];
    for (let i = 0; i < n; i++) {
      const t = data.tables[i];
      const h = 30 + Math.min(t.columns.length, 30) * 18 + (t.columns.length > 30 ? 18 : 0);
      const r = Math.floor(i / cols);
      rowHeights[r] = Math.max(rowHeights[r] || 0, h);
    }
    let y = 20;
    for (let r = 0; r * cols < n; r++) {
      for (let c = 0; c < cols && r * cols + c < n; c++) {
        const t = data.tables[r * cols + c];
        const h = 30 + Math.min(t.columns.length, 30) * 18 + (t.columns.length > 30 ? 18 : 0);
        positions.set(t.name, { x: 20 + c * (colW + gapX), y, w: colW, h });
      }
      y += rowHeights[r] + gapY;
    }
  }
  autoLayout();

  // ---- SVG + nodes ----
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'map-svg');
  // marker for arrowheads
  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333" /></marker>`;
  svg.appendChild(defs);
  const edgesGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(edgesGroup);
  canvas.appendChild(svg);

  // Pan & zoom
  let zoom = 1, panX = 0, panY = 0;
  const world = el('div', { class: 'map-world' });
  canvas.appendChild(world);
  function applyTransform() {
    world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    svg.style.transform = world.style.transform;
  }
  applyTransform();
  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = -Math.sign(e.deltaY) * 0.1;
    const newZoom = Math.max(0.2, Math.min(2.5, zoom + delta));
    zoom = newZoom; applyTransform();
  }, { passive: false });
  let panning = false, panStart = null;
  canvas.addEventListener('mousedown', (e) => {
    if (e.target !== canvas && e.target !== svg) return;
    panning = true; panStart = { x: e.clientX - panX, y: e.clientY - panY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!panning) return;
    panX = e.clientX - panStart.x; panY = e.clientY - panStart.y; applyTransform();
  });
  window.addEventListener('mouseup', () => { panning = false; });
  zoomIn.onclick = () => { zoom = Math.min(2.5, zoom + 0.1); applyTransform(); };
  zoomOut.onclick = () => { zoom = Math.max(0.2, zoom - 0.1); applyTransform(); };
  zoomReset.onclick = () => { zoom = 1; panX = 0; panY = 0; applyTransform(); };
  relayout.onclick = () => { autoLayout(); renderNodes(); drawEdges(); };

  // node DOM
  const nodeEls = new Map();
  function renderNodes() {
    world.innerHTML = '';
    nodeEls.clear();
    for (const t of data.tables) {
      const p = positions.get(t.name);
      const node = el('div', { class: 'map-node', 'data-table': t.name });
      node.style.left = p.x + 'px';
      node.style.top = p.y + 'px';
      node.style.width = p.w + 'px';
      const title = el('div', { class: 'map-node-title' }, t.name);
      title.title = 'Click to open · drag to move';
      title.addEventListener('dblclick', () => {
        state.view = 'tables';
        selectTable(t.name);
      });
      node.appendChild(title);
      const pkSet = new Set(t.primaryKey);
      const fkColsForTable = new Set();
      for (const ed of data.edges) if (ed.fromTable === t.name) for (const c of ed.fromColumns) fkColsForTable.add(c);
      const colsContainer = el('div', { class: 'map-node-cols' });
      const maxShow = 30;
      const showCols = t.columns.slice(0, maxShow);
      for (const c of showCols) {
        const row = el('div', { class: 'map-col', 'data-col': c.name });
        const tags = [];
        if (pkSet.has(c.name)) tags.push('PK');
        if (fkColsForTable.has(c.name)) tags.push('FK');
        row.appendChild(el('span', { class: 'map-col-name' }, c.name));
        row.appendChild(el('span', { class: 'map-col-type' }, c.type));
        if (tags.length) row.appendChild(el('span', { class: 'map-col-tag' }, tags.join('·')));
        colsContainer.appendChild(row);
      }
      if (t.columns.length > maxShow) {
        colsContainer.appendChild(el('div', { class: 'map-col map-more' }, `+ ${t.columns.length - maxShow} more`));
      }
      node.appendChild(colsContainer);

      // drag
      let dragging = false, ds = null;
      title.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        dragging = true;
        ds = { x: e.clientX, y: e.clientY, ox: p.x, oy: p.y };
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        p.x = ds.ox + (e.clientX - ds.x) / zoom;
        p.y = ds.oy + (e.clientY - ds.y) / zoom;
        node.style.left = p.x + 'px';
        node.style.top = p.y + 'px';
        drawEdges();
      });
      window.addEventListener('mouseup', () => { dragging = false; });

      world.appendChild(node);
      nodeEls.set(t.name, node);
      // measure actual height for accurate edge anchoring
      requestAnimationFrame(() => {
        p.h = node.offsetHeight || p.h;
        drawEdges();
      });
    }
  }

  function anchorFor(tableName, columnName) {
    const p = positions.get(tableName);
    if (!p) return null;
    const node = nodeEls.get(tableName);
    if (!node) return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    const colEl = node.querySelector(`.map-col[data-col="${CSS.escape(columnName)}"]`);
    if (!colEl) return { x: p.x + p.w / 2, y: p.y + p.h / 2, midY: p.y + p.h / 2 };
    const rel = colEl.offsetTop + colEl.offsetHeight / 2;
    return { left: p.x, right: p.x + p.w, y: p.y + rel, w: p.w };
  }

  function drawEdges() {
    // Determine SVG size
    let maxX = 0, maxY = 0;
    for (const p of positions.values()) { maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h); }
    svg.setAttribute('width', maxX + 60);
    svg.setAttribute('height', maxY + 60);
    edgesGroup.innerHTML = '';
    for (const ed of data.edges) {
      if (ed.toSchema && ed.toSchema !== state.schema) continue; // skip cross-schema for now
      if (!tableByName.has(ed.toTable)) continue;
      const a = anchorFor(ed.fromTable, ed.fromColumns[0]);
      const b = anchorFor(ed.toTable, ed.toColumns[0]);
      if (!a || !b) continue;
      // pick sides: connect closer horizontal side
      const ax = (a.left + a.right) / 2;
      const bx = (b.left + b.right) / 2;
      const aSide = ax < bx ? a.right : a.left;
      const bSide = ax < bx ? b.left : b.right;
      const ay = a.y, by = b.y;
      const dx = Math.abs(bSide - aSide);
      const curve = Math.min(120, Math.max(30, dx / 2));
      const c1x = aSide + (ax < bx ? curve : -curve);
      const c2x = bSide + (ax < bx ? -curve : curve);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M ${aSide} ${ay} C ${c1x} ${ay}, ${c2x} ${by}, ${bSide} ${by}`);
      path.setAttribute('class', 'map-edge');
      path.setAttribute('marker-end', 'url(#arrow)');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${ed.fromTable}.${ed.fromColumns.join(',')} → ${ed.toTable}.${ed.toColumns.join(',')}`;
      path.appendChild(title);
      edgesGroup.appendChild(path);
    }
  }

  renderNodes();
  // edges drawn via rAF after nodes mount
}

// ---------------- SQL view ----------------
function renderSql(root) {
  const wrap = el('div', { class: 'sql-wrap' });
  wrap.appendChild(el('h2', { style: 'font-size:14px;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px' }, 'SQL'));
  const ta = el('textarea', { spellcheck: 'false', placeholder: 'SELECT 1;' });
  ta.value = sessionStorage.getItem('pb.sql') || '';
  ta.addEventListener('input', () => sessionStorage.setItem('pb.sql', ta.value));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });
  wrap.appendChild(ta);
  const tb = el('div', { class: 'toolbar' });
  const runBtn = el('button', { class: 'primary', onclick: run }, 'Run  (Ctrl+Enter)');
  tb.appendChild(runBtn);
  const notice = el('div', { class: 'notice' });
  tb.appendChild(notice);
  wrap.appendChild(tb);
  const out = el('div', { class: 'sql-result' });
  wrap.appendChild(out);
  root.appendChild(wrap);

  async function run() {
    notice.className = 'notice'; notice.textContent = 'Running…';
    out.innerHTML = '';
    runBtn.disabled = true;
    try {
      const r = await api('/api/query', { method: 'POST', body: { sql: ta.value } });
      notice.className = 'notice ok';
      notice.textContent = `${r.command || 'OK'} · ${r.rowCount ?? 0} row(s)`;
      if (r.rows && r.rows.length > 0) {
        const cols = r.fields.map(f => f.name);
        out.appendChild(el('div', { class: 'result-bar' },
          el('span', { class: 'muted-note' }, `${r.rows.length} row(s)`),
          el('span', { style: 'flex:1' }),
          el('button', { class: 'sm', title: 'Export result as CSV', onclick: () => exportRows(r.rows, cols, 'csv', 'query') }, '⭳ CSV'),
          el('button', { class: 'sm', title: 'Export result as JSON', onclick: () => exportRows(r.rows, cols, 'json', 'query') }, '⭳ JSON'),
        ));
        const tbl = el('table', { class: 'data' });
        const thead = el('thead'); const hr = el('tr');
        for (const f of r.fields) hr.appendChild(el('th', {}, f.name));
        thead.appendChild(hr); tbl.appendChild(thead);
        const tbody = el('tbody');
        for (const row of r.rows) {
          const tr = el('tr');
          for (const f of r.fields) {
            const td = el('td');
            td.appendChild(fmtCell(row[f.name]));
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        tbl.appendChild(tbody);
        out.appendChild(tbl);
      }
    } catch (e) {
      notice.className = 'notice error';
      notice.textContent = e.message;
    } finally {
      runBtn.disabled = false;
    }
  }
}

// ---------------- Bulk row generator ----------------
function openBulkGenerator() {
  if (!window.PBGen) { alert('Generators not loaded'); return; }
  if (!state.columns || state.columns.length === 0) { alert('No columns'); return; }

  const body = el('div', { class: 'bulkgen' });

  // Top: row count
  const top = el('div', { class: 'bulkgen-top' });
  top.appendChild(el('label', {}, 'Number of rows'));
  const countInput = el('input', { type: 'number', min: '1', max: '100000', value: '50', style: 'width:120px' });
  top.appendChild(countInput);
  const presetSel = el('select', { onchange: (e) => { if (e.target.value) countInput.value = e.target.value; e.target.value = ''; } });
  presetSel.appendChild(el('option', { value: '' }, 'Preset…'));
  for (const n of [10, 50, 100, 500, 1000, 5000, 10000]) presetSel.appendChild(el('option', { value: n }, String(n)));
  top.appendChild(presetSel);
  const previewBtn = el('button', {}, 'Preview 1 row');
  top.appendChild(previewBtn);
  body.appendChild(top);

  // Column rows
  const grid = el('div', { class: 'bulkgen-grid' });
  grid.appendChild(el('div', { class: 'bulkgen-h' }, 'Column'));
  grid.appendChild(el('div', { class: 'bulkgen-h' }, 'Type'));
  grid.appendChild(el('div', { class: 'bulkgen-h' }, 'Options'));

  // plan: column_name -> { id, opts, controls: {optsEl} }
  const plan = {};
  const cats = window.PBGen.listByCategory();

  // Cache of FK pools: "schema.table.column" -> Promise<values[]>
  const fkPoolCache = {};
  function loadFkPool(fk) {
    const key = `${fk.refSchema}.${fk.refTable}.${fk.refColumn}`;
    if (!fkPoolCache[key]) {
      fkPoolCache[key] = api(`/api/fk-values?schema=${encodeURIComponent(fk.refSchema)}&table=${encodeURIComponent(fk.refTable)}&column=${encodeURIComponent(fk.refColumn)}&limit=5000`)
        .then(r => r.values || [])
        .catch(() => []);
    }
    return fkPoolCache[key];
  }

  function buildOptsArea(container, def, current, col) {
    container.innerHTML = '';
    // Hint for the SKIP / default generator
    if (def && def.id === 'default') {
      const txt = col.column_default
        ? `uses DB default: ${String(col.column_default).slice(0, 60)}`
        : 'column omitted (uses DB default / NULL)';
      container.appendChild(el('span', { class: 'opt-hint' }, txt));
      return;
    }
    // Special hint for fk_pick
    if (def && def.id === 'fk_pick') {
      const fk = state.fkByColumn[col.column_name];
      const hint = el('span', { class: 'opt-hint' }, fk ? `→ ${fk.refSchema}.${fk.refTable}.${fk.refColumn}: loading…` : 'No FK detected on this column');
      container.appendChild(hint);
      if (fk) {
        loadFkPool(fk).then(values => {
          plan[col.column_name].opts.pool = values;
          hint.textContent = `→ ${fk.refSchema}.${fk.refTable}.${fk.refColumn}: ${values.length} valid value(s)`;
          if (values.length === 0) hint.className = 'opt-hint warn';
        });
      }
      return;
    }
    if (!def || !def.opts || def.opts.length === 0) return;
    for (const o of def.opts) {
      const inp = el('input', {
        type: 'text',
        placeholder: o.placeholder || o.label,
        value: (current && current[o.key] != null) ? current[o.key] : (o.default || ''),
        style: 'width:140px;margin-right:4px',
        title: o.label,
        oninput: () => { plan[col.column_name].opts[o.key] = inp.value; },
      });
      // seed plan with initial value
      if (inp.value && plan[col.column_name].opts[o.key] == null) {
        plan[col.column_name].opts[o.key] = inp.value;
      }
      container.appendChild(inp);
    }
  }

  const pkSet = new Set(state.primaryKey || []);
  for (const c of state.columns) {
    // Tag FK / PK columns so autoDetect can decide intelligently
    const fk = state.fkByColumn[c.column_name];
    const isPk = pkSet.has(c.column_name);
    const colWithMeta = { ...c, __isFk: !!fk, __isPk: isPk };
    const autoId = window.PBGen.autoDetect(colWithMeta);
    plan[c.column_name] = { id: autoId, opts: {} };

    // Seed opts for special auto picks
    if (autoId === 'enum' && Array.isArray(c.enum_values)) {
      plan[c.column_name].opts.values = c.enum_values.join(',');
    }
    if (autoId === 'fk_pick' && fk) {
      plan[c.column_name].opts.pool = [];
      loadFkPool(fk).then(values => { plan[c.column_name].opts.pool = values; });
    }

    grid.appendChild(el('div', { class: 'bulkgen-col' },
      el('div', {}, c.column_name + (isPk ? ' 🔑' : '') + (fk ? ' →' : '') + (Array.isArray(c.enum_values) ? ' ⊙' : '')),
      el('div', { class: 'col-type' },
        c.data_type
        + (c.is_nullable === 'YES' ? ' · null' : '')
        + (c.column_default ? ' · has default' : '')
        + (Array.isArray(c.enum_values) ? ` · enum(${c.enum_values.length})` : '')
        + (fk ? ` · fk ${fk.refTable}.${fk.refColumn}` : '')
      ),
    ));

    const sel = el('select', { class: 'bulkgen-sel' });
    for (const [catName, gens] of cats) {
      const og = el('optgroup', { label: catName });
      for (const g of gens) {
        const o = el('option', { value: g.id }, g.label);
        if (g.id === autoId) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    grid.appendChild(sel);

    const optsWrap = el('div', { class: 'bulkgen-opts' });
    grid.appendChild(optsWrap);

    // initial opts area
    const def = window.PBGen.getById(autoId);
    buildOptsArea(optsWrap, def, plan[c.column_name].opts, c);

    sel.addEventListener('change', () => {
      const newId = sel.value;
      const nd = window.PBGen.getById(newId);
      plan[c.column_name] = { id: newId, opts: {} };
      // seed defaults from generator definition
      if (nd && nd.opts) for (const o of nd.opts) if (o.default != null) plan[c.column_name].opts[o.key] = o.default;
      // re-seed for fk_pick / enum if user re-selects them on a tagged column
      if (newId === 'enum' && Array.isArray(c.enum_values)) {
        plan[c.column_name].opts.values = c.enum_values.join(',');
      }
      if (newId === 'fk_pick' && fk) {
        plan[c.column_name].opts.pool = [];
        loadFkPool(fk).then(values => { plan[c.column_name].opts.pool = values; });
      }
      buildOptsArea(optsWrap, nd, plan[c.column_name].opts, c);
    });
  }
  body.appendChild(grid);

  // Unique constraint summary
  const uqs = (state.uniqueConstraints || []).filter(u => Array.isArray(u.columns) && u.columns.length > 0);
  if (uqs.length > 0) {
    const ul = el('div', { class: 'bulkgen-uniq' });
    ul.appendChild(el('div', { class: 'bulkgen-uniq-h' }, 'Unique constraints (rows colliding on these will be skipped):'));
    for (const u of uqs) {
      ul.appendChild(el('div', { class: 'bulkgen-uniq-item' }, `· (${u.columns.join(', ')})`));
    }
    body.appendChild(ul);
  }

  const notice = el('div', { class: 'notice' });
  body.appendChild(notice);

  const preview = el('pre', { class: 'bulkgen-preview' });
  body.appendChild(preview);

  previewBtn.addEventListener('click', async () => {
    try {
      const sample = await window.PBGen.generateRows({
        columns: state.columns, count: 1, plan,
      });
      preview.textContent = JSON.stringify(sample[0], null, 2);
    } catch (e) {
      preview.textContent = 'Error: ' + e.message;
    }
  });

  const m = modal({
    title: `Generate rows in ${state.schema}.${state.table}`,
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      {
        label: 'Generate & Insert',
        class: 'primary',
        onClick: async (close) => {
          const n = Math.max(1, Math.min(100000, parseInt(countInput.value, 10) || 0));
          if (!n) { notice.className = 'notice error'; notice.textContent = 'Invalid row count'; return; }
          if (n > 1000 && !confirm(`Insert ${n} rows? This may take a moment.`)) return;
          notice.className = 'notice'; notice.textContent = `Generating ${n} rows…`;
          try {
            // Which unique constraints can we enforce client-side? Skip any constraint
            // whose columns are produced by 'default' (Postgres assigns them).
            const uniques = (state.uniqueConstraints || []).filter(u => {
              if (!Array.isArray(u.columns) || u.columns.length === 0) return false;
              return u.columns.every(c => {
                const p = plan[c];
                return p && p.id !== 'default';
              });
            });

            // Pre-fetch existing tuples for each unique constraint
            const existingSets = [];
            for (const u of uniques) {
              try {
                const r = await api('/api/unique-tuples', {
                  method: 'POST',
                  body: { schema: state.schema, table: state.table, columns: u.columns, limit: 50000 },
                });
                const set = new Set();
                for (const row of (r.rows || [])) {
                  set.add(JSON.stringify(u.columns.map(c => row[c] ?? null)));
                }
                existingSets.push({ u, set });
              } catch (_) { existingSets.push({ u, set: new Set() }); }
            }

            // Retry loop: keep generating until we have n unique rows, or until
            // we make no progress for several attempts (combinatorially exhausted).
            const seenBatchSets = existingSets.map(() => new Set());
            const kept = [];
            let droppedDup = 0, droppedExisting = 0;
            let stalledRounds = 0;
            const MAX_STALLED = 8;        // give up after this many fruitless waves
            const MAX_TOTAL_GENERATED = Math.max(n * 50, 20000); // safety ceiling
            let totalGenerated = 0;

            while (kept.length < n && stalledRounds < MAX_STALLED && totalGenerated < MAX_TOTAL_GENERATED) {
              const need = n - kept.length;
              // Over-generate to amortize collision rate; grow on each stall.
              const wave = Math.min(MAX_TOTAL_GENERATED - totalGenerated, Math.max(need * (2 + stalledRounds), 32));
              const before = kept.length;
              const batch = await window.PBGen.generateRows({ columns: state.columns, count: wave, plan });
              totalGenerated += batch.length;

              for (const row of batch) {
                if (kept.length >= n) break;
                let ok = true;
                for (let i = 0; i < existingSets.length; i++) {
                  const { u, set } = existingSets[i];
                  const key = JSON.stringify(u.columns.map(c => row[c] ?? null));
                  if (set.has(key)) { ok = false; droppedExisting++; break; }
                  if (seenBatchSets[i].has(key)) { ok = false; droppedDup++; break; }
                }
                if (ok) {
                  for (let i = 0; i < existingSets.length; i++) {
                    const { u } = existingSets[i];
                    seenBatchSets[i].add(JSON.stringify(u.columns.map(c => row[c] ?? null)));
                  }
                  kept.push(row);
                }
              }
              stalledRounds = (kept.length === before) ? stalledRounds + 1 : 0;
              if (kept.length < n) {
                notice.textContent = `Generating… ${kept.length}/${n} unique (${droppedDup + droppedExisting} collisions skipped)`;
              }
            }

            const rows = kept;
            if (rows.length === 0) {
              notice.className = 'notice error';
              notice.textContent = `Could not generate any unique rows. Try widening generator ranges or adding more reference data.`;
              return;
            }
            if (rows.length < n) {
              notice.className = 'notice error';
              notice.textContent = `Only ${rows.length}/${n} unique rows possible without violating unique constraints (combinations exhausted). Insert anyway? Click again to confirm.`;
              // Two-click confirmation: change handler state via dataset
              const btn = document.querySelector('.modal-backdrop:last-of-type footer .primary');
              if (btn && btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; return; }
            }
            const dropMsg = (droppedDup + droppedExisting) > 0
              ? ` (${droppedDup + droppedExisting} collisions skipped)` : '';
            notice.className = 'notice';
            notice.textContent = `Inserting ${rows.length} rows${dropMsg}…`;
            const r = await api('/api/insert-bulk', {
              method: 'POST',
              body: { schema: state.schema, table: state.table, rows },
            });
            close();
            await loadRows(); renderMain();
            console.log(`Inserted ${r.inserted} rows${dropMsg}`);
          } catch (e) {
            notice.className = 'notice error';
            notice.textContent = e.message;
          }
        },
      },
    ],
  });
  // make the modal a bit wider for the grid
  const modalEl = document.querySelector('.modal-backdrop:last-of-type .modal');
  if (modalEl) modalEl.style.maxWidth = '820px';
}
