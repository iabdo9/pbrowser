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
  view: 'tables', // 'tables' | 'sql'
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

// ---------------- API ----------------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
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
  tSec.appendChild(el('h3', {}, `Tables (${state.tables.length})`));
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
  if (state.view === 'sql') return renderSql(main);
  if (!state.table) {
    main.appendChild(el('div', { class: 'empty' }, 'Select a table from the left.'));
    return;
  }
  renderTable(main);
}

// ---------------- Connect view ----------------
function renderConnect(root) {
  const wrap = el('div', { class: 'connect-wrap' });
  wrap.appendChild(el('h2', {}, 'Connect to PostgreSQL'));
  wrap.appendChild(el('label', { for: 'cs' }, 'Connection string'));
  const input = el('input', {
    id: 'cs', type: 'text',
    placeholder: 'postgres://user:pass@host:5432/dbname',
    value: state.defaultPgUrl || '',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  wrap.appendChild(input);
  wrap.appendChild(el('p', { class: 'hint' }, 'Format: postgres://user:password@host:port/database. SSL options can be appended as query parameters.'));
  const err = el('div', { class: 'error' });
  const btn = el('button', {
    class: 'primary',
    onclick: async () => {
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const j = await api('/api/connect', { method: 'POST', body: { connectionString: input.value } });
        state.connected = true; state.info = j.info;
        await loadSchemas();
        renderAll();
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
  await loadColumns();
  await loadRows();
  renderSide(); renderMain();
}
async function loadColumns() {
  const r = await api(`/api/columns?schema=${encodeURIComponent(state.schema)}&table=${encodeURIComponent(state.table)}`);
  state.columns = r.columns;
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
    onclick: () => openBulkGenerator(),
    title: 'Insert many rows with random data',
  }, '⚡ Generate rows'));
  toolbar.appendChild(el('button', { onclick: refresh }, 'Refresh'));

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
            // Try to coerce numerics / booleans / json for known types
            if (['json', 'jsonb'].some(t => c.data_type.includes(t))) {
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
