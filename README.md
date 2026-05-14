# pbrowser

A minimalist Node.js + web-based PostgreSQL browser with authentication.

## Features

- Username/password authentication, optional TOTP (RFC 6238) second factor.
- All credentials are loaded from `.env` — no public access.
- After login, the user enters any Postgres **connection string** (per-session, isolated pool).
- Browse schemas → tables → rows with pagination and sorting.
- Full **CRUD**: insert, edit, and delete rows (PK auto-detected).
- Raw SQL editor with Ctrl/Cmd+Enter to run.
- Clean black-and-white minimalist UI, no framework.

## Setup

```bash
cd pbrowser
cp .env.example .env
# edit .env and set AUTH_USER, AUTH_PASS, SESSION_SECRET, (optionally) TOTP_SECRET
npm install
npm start
```

Open <http://localhost:3000>.

## .env reference

| Variable          | Required | Purpose                                                    |
|-------------------|----------|------------------------------------------------------------|
| `AUTH_USER`       | yes      | Login username                                             |
| `AUTH_PASS`       | yes      | Login password                                             |
| `SESSION_SECRET`  | yes¹     | Cookie session signing secret                              |
| `TOTP_SECRET`     | no       | Base32 TOTP secret; if set, a 6-digit code is required     |
| `PORT`            | no       | Listen port (default 3000)                                 |
| `DEFAULT_PG_URL`  | no       | Pre-fills the connect-page input                           |

¹ A random secret is generated at startup if you omit it, but sessions will not survive a restart.

### Generating a TOTP secret

Any standard base32 secret works. Example (Node):

```bash
node -e "console.log(require('otpauth').Secret.fromUTF8(require('crypto').randomBytes(20).toString('hex')).base32)"
```

Add it to your authenticator app (Aegis, Google Authenticator, etc.) by manual entry with the same base32 string, then put it in `.env` as `TOTP_SECRET`.

## Notes

- Each session opens its own Postgres pool. Pools are closed on logout/disconnect.
- Identifiers (schema, table, column names) are double-quoted; values are passed as parameters — no string concatenation of user values into SQL.
- Tables without a primary key are read-only in the row editor; use the SQL view to modify them.
- The browser binds to all interfaces; restrict access at the network/reverse-proxy layer or set `PORT` to a loopback-only setup (e.g. via `bind` in your proxy).
