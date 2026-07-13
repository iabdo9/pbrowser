# pbrowser

A minimalist, self-hosted PostgreSQL browser for the web. Login, paste a connection string, and you get a clean black-and-white UI to explore schemas, browse and edit rows, follow foreign keys, generate realistic random data, and bulk-delete with checkboxes — all without a single framework on the front end.

> Built for developers who want pgAdmin-style power with the ergonomics of a static page.

## Highlights

- 🔐 **Authentication built in** — username/password from `.env`, optional TOTP (RFC 6238) second factor.
- 🔌 **Per-session connection** — users paste any Postgres URL after login; each session gets its own isolated pool.
- 🗂️ **Schema browser** — schemas → tables → rows with pagination, sorting, and free-text filtering.
- ✏️ **Full CRUD** with type-aware inputs: enum columns become `<select>`s, booleans become toggles, foreign keys become searchable pickers.
- 🔗 **Foreign-key navigation** — outgoing FKs render as clickable links; every row exposes a "Related" view that pulls in incoming references.
- ⚡ **Bulk random row generator** — ~80 generators across 11 categories (names, addresses, dates, ids, lorem, etc.) with FK-valid picks, enum seeding, unique-constraint deduping, and exact-count retry.
- ☑️ **Bulk delete with checkboxes** — select rows across pages, transactional batched delete, supports composite primary keys.
- 🗺️ **Schema map** — interactive ER-style diagram of every table, column, PK/FK tag, and relationship; drag, zoom, pan, and double-click a table to jump straight to its rows.
- 🧪 **Raw SQL editor** — Ctrl/Cmd+Enter to run, results rendered as a table.
- 🖤 **Minimalist UI** — vanilla JS, vanilla CSS, no build step.

## Quick start

```bash
git clone https://github.com/iabdo9/pbrowser.git
cd pbrowser
cp .env.example .env
# edit .env — set AUTH_USER, AUTH_PASS, SESSION_SECRET
npm install
npm start
```

Open <http://localhost:3000>, login, then paste a Postgres connection string such as:

```
postgres://user:password@host:5432/dbname
```

### Development

```bash
npm run dev    # node --watch server.js
```

## Configuration

All configuration is read from `.env` at startup.

| Variable          | Required | Default | Purpose                                                              |
| ----------------- | :------: | :-----: | -------------------------------------------------------------------- |
| `AUTH_USER`       | ✅       | —       | Login username                                                       |
| `AUTH_PASS`       | ✅       | —       | Login password                                                       |
| `SESSION_SECRET`  | ✅¹      | random  | Cookie session signing secret                                        |
| `TOTP_SECRET`     |          | —       | Base32 TOTP secret. When set, a 6-digit code is required on login.   |
| `PORT`            |          | `3000`  | HTTP listen port                                                     |
| `DEFAULT_PG_URL`  |          | —       | Pre-fills the connection-string input on the connect page            |

¹ A random secret is generated at startup if you omit `SESSION_SECRET`, but every restart will invalidate active sessions.

### Enabling TOTP

Generate a base32 secret, add it to your authenticator app (Aegis, 1Password, Google Authenticator, …) and to your `.env`:

```bash
node -e "console.log(require('otpauth').Secret.fromUTF8(require('crypto').randomBytes(20).toString('hex')).base32)"
```

```env
TOTP_SECRET=JBSWY3DPEHPK3PXP...
```

When `TOTP_SECRET` is set, the login form shows a 6-digit code field.

## Feature tour

### Browsing & editing

- Click any table in the sidebar to load rows.
- Click a column header to sort; the filter box does a server-side `ILIKE` across text columns.
- Use **+ Row** to insert; the editor knows about enums, booleans, foreign keys, defaults, and nullability.
- Tables without a primary key are read-only in the row editor — use the SQL view to modify them.

### Foreign-key navigation

- Cells whose column is an FK render as clickable links that jump to the referenced row.
- Each row exposes a **Related** button that lists all incoming references grouped by table.

### Bulk random data

Click **⚡ Generate rows** on any table:

- Pick a count and an optional preset.
- Each column gets an auto-detected generator (e.g. `email`, `uuid_v4`, `date_past`, `fk_pick`, `enum`); change any of them from a dropdown.
- FK columns are pre-loaded with valid target values; enum columns are seeded with valid labels.
- Unique constraints (including Prisma-style `@@unique` indexes) are detected; the generator retries until N unique rows are produced or combinations are exhausted.
- Inserts run in transactional batches of 200.

### Bulk delete

- Tables with a primary key get a leftmost checkbox column.
- Tick rows individually or use the header checkbox to select all on the current page (supports an indeterminate state).
- Selection **persists across pages**, so you can accumulate rows and delete them at once.
- The **🗑 Delete N selected** button runs a transactional delete in 500-row batches. Single-column PKs use `WHERE pk = ANY($1)`; composite PKs use `WHERE (a, b) IN ((..), (..))`.

### SQL

The **SQL** view runs arbitrary statements against the active connection. Ctrl/Cmd+Enter to execute. Results are rendered as a table.

### Schema map

The **Map** view in the sidebar renders the entire current schema as an interactive diagram:

- Each table is a node with a dark title bar and a row per column showing the type and **PK** / **FK** tags.
- Foreign keys are drawn as bezier arrows from the child column to the referenced parent column (composite FKs included; hover an edge for a `from.col → to.col` tooltip).
- Drag a node by its title bar to rearrange; **Relayout** snaps everything back to an auto-grid.
- Pan by dragging the empty canvas, zoom with `Ctrl/Cmd + wheel` or the `+` / `−` / `100%` buttons.
- Double-click a node title to jump to that table's rows in the Tables view.
- Powered by a single `/api/schema-map` query — no build step, no diagramming library, just SVG + DOM.

## Architecture

```
┌──────────────────────────┐        ┌───────────────────────────┐
│  Browser (vanilla JS)    │  HTTP  │  Express server           │
│  public/index.html       │ ─────▶ │  server.js                │
│  public/app.js           │        │  ├─ session (cookie)      │
│  public/generators.js    │ ◀───── │  ├─ per-session pg.Pool   │
│  public/style.css        │        │  └─ pg (node-postgres)    │
└──────────────────────────┘        └─────────────┬─────────────┘
                                                  │ TCP
                                                  ▼
                                            PostgreSQL
```

- **No build step.** The frontend is plain ES modules and CSS served statically.
- **Per-session pool.** Each authenticated session owns a `pg.Pool`, stored in a `Map<sessionID, …>`. Pools are closed on logout/disconnect.
- **SQL safety.** All identifiers (schemas, tables, columns) are double-quoted; all values pass through parameterized queries. There is no string concatenation of user values into SQL.

## API

Internal HTTP endpoints (session-authenticated, JSON):

| Method | Path                  | Purpose                                              |
| ------ | --------------------- | ---------------------------------------------------- |
| POST   | `/api/login`          | Username/password (+ TOTP) login                     |
| POST   | `/api/logout`         | Destroy session and pool                             |
| GET    | `/api/me`             | Current session info                                 |
| POST   | `/api/connect`        | Open a Postgres pool for this session                |
| POST   | `/api/disconnect`     | Close the pool                                       |
| GET    | `/api/schemas`        | List schemas and tables                              |
| GET    | `/api/columns`        | Columns, PK, FKs, unique constraints/indexes, enums  |
| GET    | `/api/schema-map`     | All tables, columns, and FK edges in a schema        |
| GET    | `/api/rows`           | Paginated rows with sort/filter                      |
| GET    | `/api/related`        | Incoming references for a row                        |
| GET    | `/api/fk-values`      | Foreign-key value picker                             |
| GET    | `/api/unique-tuples`  | Existing tuples for unique-constraint deduping       |
| POST   | `/api/insert`         | Insert a single row                                  |
| POST   | `/api/insert-bulk`    | Transactional batched insert                         |
| POST   | `/api/update`         | Update by PK                                         |
| POST   | `/api/delete`         | Delete a single row by PK                            |
| POST   | `/api/delete-bulk`    | Transactional batched delete by PK list              |
| POST   | `/api/query`          | Run arbitrary SQL                                    |

## Security notes

- Treat pbrowser as a privileged tool — anyone with login credentials can read and modify any database whose connection string they can supply.
- Run it behind HTTPS and a reverse proxy. The server binds to all interfaces by default.
- Use a strong `SESSION_SECRET`, enable `TOTP_SECRET`, and restrict network access (firewall, VPN, or proxy `bind`).
- Connection strings are kept in server memory for the lifetime of the session and are never persisted to disk.

## Tech stack

- **Server:** Node.js 18+, Express 4, `pg` 8, `express-session`, `otpauth`, `dotenv`.
- **Client:** Vanilla JS, no framework, no bundler.
- **Database:** Tested against PostgreSQL 13+.

## Roadmap

- [ ] Export selection / query results as CSV / JSON.
- [ ] Saved queries.
- [ ] Per-connection bookmarks.
- [ ] Dark mode.

PRs welcome — see [Contributing](#contributing).

## Contributing

1. Fork and clone.
2. `npm install`.
3. Make your changes; run `node --check server.js && node --check public/app.js` to sanity-check syntax.
4. Open a pull request describing the change and how you tested it.

## License

MIT — see [LICENSE](LICENSE).
