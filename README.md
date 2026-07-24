# pbrowser

> [!WARNING]
> **Never use this tool in production.**
>
> pbrowser is built for local development and throwaway databases. It hands whoever
> is logged in full read/write access to any database they can reach, runs arbitrary
> SQL, and deletes rows in bulk. It has not been hardened or audited for
> production use.
>
> If you deploy it against a production database anyway, **you do so entirely at your
> own risk and take full responsibility for the consequences** — including data loss,
> corruption, and credential exposure. The author provides no warranty and accepts no
> liability (see [LICENSE](LICENSE)).

A minimalist, self-hosted PostgreSQL browser for the web. Login, paste a connection string, and you get a clean black-and-white UI to explore schemas, browse and edit rows, follow foreign keys, generate realistic random data, and bulk-delete with checkboxes — all without a single framework on the front end.

> Built for developers who want pgAdmin-style power with the ergonomics of a static page.

![Browsing rows in the table view](docs/screenshots/03-rows.png)

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

## Screenshots

All screenshots below were taken against a throwaway demo database seeded with
synthetic data — no real records appear anywhere. Passwords and connection
strings are blurred.

### Sign in

Username and password come from `.env`. When `TOTP_SECRET` is set, a third field
appears for the 6-digit code.

![Sign-in screen with the password field blurred](docs/screenshots/01-login.png)

### Connect

Successful connections are remembered for one-click reconnect; the connection
string itself never leaves the server, so the cards only show host/user/database.

![Connect page listing recent connections above a connection-string field](docs/screenshots/02-connect.png)

### Browse and edit rows

Paginated rows with sortable headers and free-text filtering. Foreign-key cells
are clickable, and every row gets **Related**, **Edit** and **Delete** actions.

![Row list for public.orders](docs/screenshots/03-rows.png)

The editor is type-aware: enums render as `<select>`s, foreign keys as pickers,
nullable columns get a NULL toggle, and defaults are shown inline.

![Edit-row dialog for a single order](docs/screenshots/04-row-editor.png)

### Follow foreign keys

**Related** pulls every incoming reference to the current row, grouped by the
table and column that points at it.

![Related-rows dialog showing addresses, orders and reviews for one customer](docs/screenshots/05-related.png)

### Generate random rows

Each column gets an auto-detected generator you can override. FK columns are
pre-loaded with valid targets, enums with valid labels, and unique constraints
are listed so colliding rows can be skipped.

![Generate-rows dialog for public.products](docs/screenshots/06-generate.png)

### Bulk delete

Selection persists across pages; the header checkbox supports an indeterminate
state, and the delete runs as a transactional batch.

![Row list with five rows checked and a "Delete 5 selected" button](docs/screenshots/07-bulk-delete.png)

### SQL

Arbitrary statements against the active connection, Ctrl/Cmd+Enter to run,
results as a table.

![SQL view running a grouped aggregate query](docs/screenshots/08-sql.png)

### Schema map

The whole schema as an interactive diagram — PK/FK tags, bezier FK arrows,
draggable nodes, zoom and pan.

![Schema map with seven tables and their foreign-key relationships](docs/screenshots/09-map.png)

### Structure

Columns, indexes and constraints for the selected table, with inline DDL actions.

![Structure view for public.products](docs/screenshots/10-structure.png)

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

**Not for production.** See the warning at the top of this file — running pbrowser
against a production database is unsupported and entirely at your own risk.

- Treat pbrowser as a privileged tool — anyone with login credentials can read and modify any database whose connection string they can supply, and can run arbitrary SQL through the SQL view.
- Run it behind HTTPS and a reverse proxy. The server binds to all interfaces by default.
- Use a strong `SESSION_SECRET`, enable `TOTP_SECRET`, and restrict network access (firewall, VPN, or proxy `bind`).
- **Saved connections are stored in plaintext.** Connection strings you save land in `connections.json` next to the server (override with `CONNECTIONS_FILE`), written `0600` and gitignored. They include database passwords. Delete the file — or skip saving connections — if that is not acceptable. Ad-hoc connections that you don't save are held only in server memory for the lifetime of the session.

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
