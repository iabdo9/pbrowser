'use strict';

// Random data generators for bulk insert.
// Each generator: { id, label, category, opts?: [{key,label,placeholder,default}], gen(ctx) }
// ctx: { i, total, opts }   (i is 0-based row index)
// Generators return a value suitable for JSON -> pg (string, number, boolean, null, or JSON-serializable object).

(function (global) {
  // ---------- utilities ----------
  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (arr) => arr[rand(arr.length)];
  const randInt = (min, max) => min + rand(max - min + 1);
  const randFloat = (min, max, dp = 2) => +(min + Math.random() * (max - min)).toFixed(dp);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const hex = (n) => Array.from({ length: n }, () => rand(16).toString(16)).join('');
  const b32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const b32 = (n) => Array.from({ length: n }, () => pick(b32chars.split(''))).join('');

  function uuidv4() {
    // RFC 4122 v4
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Sample data pools
  const FIRST_NAMES = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Daniel', 'Nancy', 'Matthew', 'Lisa', 'Anthony', 'Margaret', 'Mark', 'Betty', 'Donald', 'Sandra', 'Aisha', 'Yusuf', 'Fatima', 'Omar', 'Layla', 'Hassan', 'Maria', 'Carlos', 'Sofia', 'Diego', 'Anna', 'Ivan', 'Olga', 'Hiroshi', 'Yuki', 'Wei', 'Mei', 'Raj', 'Priya'];
  const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Khan', 'Ali', 'Nguyen', 'Tran', 'Kim', 'Park', 'Sato', 'Tanaka', 'Chen', 'Wang', 'Singh', 'Patel', 'Mueller', 'Ivanov', 'Petrov'];
  const COMPANIES = ['acme', 'globex', 'initech', 'umbrella', 'vandelay', 'wayne', 'stark', 'wonka', 'soylent', 'pied-piper', 'hooli', 'dunder', 'tyrell', 'massive', 'cyberdyne'];
  const TLDS = ['com', 'net', 'org', 'io', 'dev', 'co', 'app', 'tech', 'xyz', 'info', 'me', 'ai', 'sh'];
  const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'IT', 'ES', 'BR', 'AR', 'EG', 'SA', 'AE', 'NG', 'KE', 'ZA', 'IN', 'PK', 'CN', 'JP', 'KR', 'RU', 'UA', 'PL', 'CA', 'AU', 'MX'];
  const TIMEZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'America/Chicago', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Istanbul', 'Africa/Cairo', 'Africa/Lagos', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Australia/Sydney', 'Pacific/Auckland'];
  const CITIES = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Toronto', 'Mexico City', 'Sao Paulo', 'London', 'Paris', 'Berlin', 'Madrid', 'Rome', 'Istanbul', 'Cairo', 'Lagos', 'Nairobi', 'Dubai', 'Riyadh', 'Mumbai', 'Delhi', 'Singapore', 'Tokyo', 'Seoul', 'Shanghai', 'Beijing', 'Sydney', 'Auckland'];
  const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Ln', 'Cedar Blvd', 'Elm St', 'Park Ave', 'Sunset Dr', 'Hill Rd', 'Lake St'];
  const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];
  const COLORS = ['red', 'green', 'blue', 'yellow', 'purple', 'orange', 'black', 'white', 'cyan', 'magenta'];
  const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(' ');
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
  ];

  function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function parseRange(s, defMin, defMax) {
    const m = String(s || '').match(/^(-?\d+)\s*[-,]\s*(-?\d+)$/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
    return [defMin, defMax];
  }
  function parseList(s) {
    return String(s || '').split(/[,|]/).map(x => x.trim()).filter(Boolean);
  }

  // ---------- generators ----------
  const G = [
    // ===== Identity =====
    { id: 'null', category: 'Special', label: 'NULL', gen: () => null },
    { id: 'default', category: 'Special', label: 'Use column default / SKIP', gen: () => undefined },
    { id: 'constant', category: 'Special', label: 'Constant value', opts: [{ key: 'value', label: 'Value', default: '' }], gen: ({ opts }) => opts.value ?? '' },
    { id: 'sequence', category: 'Special', label: 'Sequence (i+start)', opts: [{ key: 'start', label: 'Start', default: '1' }, { key: 'step', label: 'Step', default: '1' }], gen: ({ i, opts }) => parseInt(opts.start || '1', 10) + i * parseInt(opts.step || '1', 10) },
    { id: 'enum', category: 'Special', label: 'Pick from list (comma-separated)', opts: [{ key: 'values', label: 'Values', placeholder: 'a,b,c' }], gen: ({ opts }) => { const v = parseList(opts.values); return v.length ? pick(v) : null; } }, {
      id: 'fk_pick', category: 'Special', label: 'Foreign key (pick valid value)', gen: ({ opts }) => {
        const pool = Array.isArray(opts && opts.pool) ? opts.pool : [];
        if (pool.length === 0) return undefined; // skip -> DEFAULT (or fail at insert if NOT NULL)
        return pool[Math.floor(Math.random() * pool.length)];
      }
    },
    // ===== Identifiers =====
    { id: 'uuid_v4', category: 'Identifiers', label: 'UUID v4', gen: () => uuidv4() },
    { id: 'hex_token', category: 'Identifiers', label: 'Hex token', opts: [{ key: 'bytes', label: 'Bytes', default: '16' }], gen: ({ opts }) => hex(2 * Math.max(1, parseInt(opts.bytes || '16', 10))) },
    { id: 'base32', category: 'Identifiers', label: 'Base32 string', opts: [{ key: 'len', label: 'Length', default: '16' }], gen: ({ opts }) => b32(Math.max(1, parseInt(opts.len || '16', 10))) },
    { id: 'slug', category: 'Identifiers', label: 'Slug (word-word-####)', gen: () => `${pick(COLORS)}-${pick(COMPANIES)}-${randInt(1000, 9999)}` },
    { id: 'snowflake', category: 'Identifiers', label: 'Snowflake-ish 64-bit int', gen: () => `${Date.now()}${pad(rand(1000), 3)}` },

    // ===== Numbers =====
    { id: 'int', category: 'Numbers', label: 'Integer (range)', opts: [{ key: 'range', label: 'min-max', default: '0-1000' }], gen: ({ opts }) => { const [a, b] = parseRange(opts.range, 0, 1000); return randInt(a, b); } },
    { id: 'bigint', category: 'Numbers', label: 'Big integer (string)', gen: () => String(randInt(0, 9_999_999_999_999)) },
    { id: 'float', category: 'Numbers', label: 'Float (range, dp)', opts: [{ key: 'range', label: 'min-max', default: '0-1' }, { key: 'dp', label: 'Decimals', default: '4' }], gen: ({ opts }) => { const [a, b] = parseRange(opts.range, 0, 1); return randFloat(a, b, parseInt(opts.dp || '4', 10)); } },
    { id: 'percent', category: 'Numbers', label: 'Percent (0–100)', gen: () => randFloat(0, 100, 2) },
    { id: 'money', category: 'Numbers', label: 'Money (0.01–9999.99)', gen: () => randFloat(0.01, 9999.99, 2) },

    // ===== Booleans =====
    { id: 'bool', category: 'Booleans', label: 'Boolean (50/50)', gen: () => Math.random() < 0.5 },
    { id: 'bool_p', category: 'Booleans', label: 'Boolean weighted', opts: [{ key: 'p', label: 'P(true) 0–1', default: '0.5' }], gen: ({ opts }) => Math.random() < (parseFloat(opts.p || '0.5')) },
    { id: 'bool_yn', category: 'Booleans', label: 'Yes/No string', gen: () => Math.random() < 0.5 ? 'yes' : 'no' },

    // ===== Person =====
    { id: 'first_name', category: 'Person', label: 'First name', gen: () => pick(FIRST_NAMES) },
    { id: 'last_name', category: 'Person', label: 'Last name', gen: () => pick(LAST_NAMES) },
    { id: 'full_name', category: 'Person', label: 'Full name', gen: () => `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}` },
    { id: 'username', category: 'Person', label: 'Username', gen: () => `${slugify(pick(FIRST_NAMES))}${randInt(10, 9999)}` },
    {
      id: 'email', category: 'Person', label: 'Email',
      opts: [{ key: 'domain', label: 'Domain (optional)', placeholder: 'example.com' }],
      gen: ({ opts }) => `${slugify(pick(FIRST_NAMES))}.${slugify(pick(LAST_NAMES))}${randInt(1, 999)}@${opts.domain || (pick(COMPANIES) + '.' + pick(TLDS))}`
    },
    { id: 'gender', category: 'Person', label: 'Gender', gen: () => pick(GENDERS) },
    {
      id: 'dob', category: 'Person', label: 'Date of birth (1950–2010)',
      gen: () => {
        const y = randInt(1950, 2010), m = randInt(1, 12), d = randInt(1, 28);
        return `${y}-${pad(m)}-${pad(d)}`;
      }
    },
    { id: 'age', category: 'Person', label: 'Age (18–80)', gen: () => randInt(18, 80) },
    { id: 'national_id', category: 'Person', label: 'National ID (digits)', opts: [{ key: 'len', label: 'Digits', default: '10' }], gen: ({ opts }) => { const n = Math.max(4, parseInt(opts.len || '10', 10)); let s = ''; for (let i = 0; i < n; i++) s += rand(10); return s; } },

    // ===== Contact / Address =====
    { id: 'phone_e164', category: 'Contact', label: 'Phone (E.164)', gen: () => `+${randInt(1, 99)}${randInt(1000000000, 9999999999)}` },
    { id: 'phone_us', category: 'Contact', label: 'Phone (US)', gen: () => `(${randInt(200, 999)}) ${randInt(200, 999)}-${randInt(1000, 9999)}` },
    { id: 'zip_us', category: 'Contact', label: 'ZIP code (US, 5)', gen: () => pad(randInt(1000, 99999), 5) },
    { id: 'zip_us9', category: 'Contact', label: 'ZIP+4 (US)', gen: () => `${pad(randInt(1000, 99999), 5)}-${pad(randInt(0, 9999), 4)}` },
    { id: 'postcode_uk', category: 'Contact', label: 'Postcode (UK-like)', gen: () => `${String.fromCharCode(65 + rand(26))}${String.fromCharCode(65 + rand(26))}${randInt(1, 99)} ${randInt(1, 9)}${String.fromCharCode(65 + rand(26))}${String.fromCharCode(65 + rand(26))}` },
    { id: 'country', category: 'Contact', label: 'Country code (ISO-2)', gen: () => pick(COUNTRIES) },
    { id: 'city', category: 'Contact', label: 'City', gen: () => pick(CITIES) },
    { id: 'street', category: 'Contact', label: 'Street address', gen: () => `${randInt(1, 9999)} ${pick(STREETS)}` },
    { id: 'address', category: 'Contact', label: 'Full address', gen: () => `${randInt(1, 9999)} ${pick(STREETS)}, ${pick(CITIES)}, ${pick(COUNTRIES)} ${pad(randInt(1000, 99999), 5)}` },
    { id: 'timezone', category: 'Contact', label: 'Timezone (IANA)', gen: () => pick(TIMEZONES) },
    { id: 'tz_offset', category: 'Contact', label: 'Timezone offset (±HH:MM)', gen: () => { const h = randInt(-12, 14); const m = pick([0, 15, 30, 45]); const sgn = h < 0 ? '-' : '+'; return `${sgn}${pad(Math.abs(h))}:${pad(m)}`; } },
    { id: 'lat', category: 'Contact', label: 'Latitude', gen: () => randFloat(-90, 90, 6) },
    { id: 'lon', category: 'Contact', label: 'Longitude', gen: () => randFloat(-180, 180, 6) },

    // ===== Internet =====
    { id: 'ipv4', category: 'Internet', label: 'IPv4', gen: () => `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}` },
    { id: 'ipv6', category: 'Internet', label: 'IPv6', gen: () => Array.from({ length: 8 }, () => hex(4)).join(':') },
    { id: 'mac', category: 'Internet', label: 'MAC address', gen: () => Array.from({ length: 6 }, () => hex(2)).join(':') },
    { id: 'domain', category: 'Internet', label: 'Domain', gen: () => `${pick(COMPANIES)}.${pick(TLDS)}` },
    { id: 'subdomain', category: 'Internet', label: 'Subdomain', gen: () => `${pick(['api', 'www', 'app', 'cdn', 'mail', 'blog', 'dev', 'staging', 'm'])}.${pick(COMPANIES)}.${pick(TLDS)}` },
    { id: 'url', category: 'Internet', label: 'URL', gen: () => `https://${pick(COMPANIES)}.${pick(TLDS)}/${pick(['users', 'products', 'posts', 'items', 'docs'])}/${randInt(1, 9999)}` },
    { id: 'user_agent', category: 'Internet', label: 'User agent', gen: () => pick(USER_AGENTS) },
    { id: 'port', category: 'Internet', label: 'Port (1024–65535)', gen: () => randInt(1024, 65535) },
    { id: 'http_method', category: 'Internet', label: 'HTTP method', gen: () => pick(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) },
    { id: 'http_status', category: 'Internet', label: 'HTTP status', gen: () => pick([200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 500, 502, 503]) },
    {
      id: 'dns_record', category: 'Internet', label: 'DNS record (rand type)',
      gen: () => {
        const t = pick(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS']);
        const host = `${pick(['api', 'www', 'mail', '_dmarc', '@'])}.${pick(COMPANIES)}.${pick(TLDS)}`;
        let val;
        if (t === 'A') val = `${randInt(1, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`;
        else if (t === 'AAAA') val = Array.from({ length: 8 }, () => hex(4)).join(':');
        else if (t === 'CNAME' || t === 'NS') val = `${pick(COMPANIES)}.${pick(TLDS)}`;
        else if (t === 'MX') val = `${randInt(1, 50)} mail.${pick(COMPANIES)}.${pick(TLDS)}`;
        else val = `"v=spf1 include:_spf.${pick(COMPANIES)}.${pick(TLDS)} -all"`;
        return `${host} ${randInt(60, 86400)} IN ${t} ${val}`;
      }
    },

    // ===== Security =====
    {
      id: 'password_plain', category: 'Security', label: 'Password (plain, random)', opts: [{ key: 'len', label: 'Length', default: '12' }], gen: ({ opts }) => {
        const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
        const n = Math.max(6, parseInt(opts.len || '12', 10));
        let s = ''; for (let i = 0; i < n; i++) s += a[rand(a.length)]; return s;
      }
    },
    { id: 'password_sha256', category: 'Security', label: 'Password SHA-256 (hex)', async: true, gen: async () => sha256Hex(uuidv4()) },
    { id: 'password_bcrypt_like', category: 'Security', label: 'Bcrypt-shaped string (fake)', gen: () => `$2b$12$${b32(22).toLowerCase()}${hex(31).slice(0, 31)}` },
    { id: 'totp_secret', category: 'Security', label: 'TOTP secret (base32, 32)', gen: () => b32(32) },
    { id: 'jwt_like', category: 'Security', label: 'JWT-shaped token (fake)', gen: () => `${b32(20).toLowerCase()}.${b32(40).toLowerCase()}.${b32(43).toLowerCase()}` },
    { id: 'api_key', category: 'Security', label: 'API key (sk_… )', gen: () => `sk_${hex(32)}` },

    // ===== Date / Time =====
    { id: 'date', category: 'Date & Time', label: 'Date (YYYY-MM-DD, last N days)', opts: [{ key: 'days', label: 'Window days', default: '365' }], gen: ({ opts }) => { const d = new Date(Date.now() - rand(parseInt(opts.days || '365', 10)) * 86400000); return d.toISOString().slice(0, 10); } },
    { id: 'date_future', category: 'Date & Time', label: 'Date (future N days)', opts: [{ key: 'days', label: 'Window days', default: '365' }], gen: ({ opts }) => { const d = new Date(Date.now() + rand(parseInt(opts.days || '365', 10)) * 86400000); return d.toISOString().slice(0, 10); } },
    { id: 'time', category: 'Date & Time', label: 'Time (HH:MM:SS)', gen: () => `${pad(rand(24))}:${pad(rand(60))}:${pad(rand(60))}` },
    { id: 'datetime_iso', category: 'Date & Time', label: 'Datetime (ISO 8601, last N days)', opts: [{ key: 'days', label: 'Window days', default: '365' }], gen: ({ opts }) => new Date(Date.now() - rand(parseInt(opts.days || '365', 10)) * 86400000 - rand(86400 * 1000)).toISOString() },
    { id: 'datetime_now', category: 'Date & Time', label: 'Datetime now (ISO)', gen: () => new Date().toISOString() },
    { id: 'unix_s', category: 'Date & Time', label: 'Unix timestamp (seconds)', gen: () => Math.floor((Date.now() - rand(365) * 86400000) / 1000) },
    { id: 'unix_ms', category: 'Date & Time', label: 'Unix timestamp (ms)', gen: () => Date.now() - rand(365) * 86400000 },
    { id: 'duration_s', category: 'Date & Time', label: 'Duration (seconds)', gen: () => randInt(1, 86400) },

    // ===== Text =====
    { id: 'word', category: 'Text', label: 'Single word', gen: () => pick(LOREM) },
    { id: 'words', category: 'Text', label: 'N words', opts: [{ key: 'n', label: 'Count', default: '3' }], gen: ({ opts }) => Array.from({ length: Math.max(1, parseInt(opts.n || '3', 10)) }, () => pick(LOREM)).join(' ') },
    { id: 'sentence', category: 'Text', label: 'Sentence', gen: () => { const n = randInt(5, 12); const w = Array.from({ length: n }, () => pick(LOREM)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(' ') + '.'; } },
    { id: 'paragraph', category: 'Text', label: 'Paragraph', gen: () => { const sents = randInt(3, 6); const out = []; for (let i = 0; i < sents; i++) { const n = randInt(5, 12); const w = Array.from({ length: n }, () => pick(LOREM)); w[0] = w[0][0].toUpperCase() + w[0].slice(1); out.push(w.join(' ') + '.'); } return out.join(' '); } },
    { id: 'color', category: 'Text', label: 'Color name', gen: () => pick(COLORS) },
    { id: 'hex_color', category: 'Text', label: 'Hex color (#rrggbb)', gen: () => '#' + hex(6) },

    // ===== JSON / Misc =====
    { id: 'json_obj', category: 'JSON', label: 'JSON object (sample)', gen: () => ({ id: uuidv4(), score: randFloat(0, 100, 2), active: Math.random() < 0.5, tags: Array.from({ length: rand(4) }, () => pick(LOREM)) }) },
    { id: 'json_arr', category: 'JSON', label: 'JSON array of ints', opts: [{ key: 'n', label: 'Length', default: '5' }], gen: ({ opts }) => Array.from({ length: Math.max(1, parseInt(opts.n || '5', 10)) }, () => randInt(0, 100)) },
    { id: 'tags_csv', category: 'JSON', label: 'Tags (CSV)', gen: () => Array.from({ length: randInt(1, 4) }, () => pick(LOREM)).join(',') },
  ];

  // ---------- auto-detect by column name + type ----------
  function autoDetect(col) {
    const name = (col.column_name || '').toLowerCase();
    const type = (col.data_type || '').toLowerCase();
    const has = (s) => name.includes(s);

    const hasDbDefault = col.column_default != null && col.column_default !== '';

    // Columns with a real DB-side default (serial/identity, nextval, gen_random_uuid,
    // now(), CURRENT_TIMESTAMP, etc.) should skip and let Postgres fill them in.
    if (hasDbDefault) return 'default';

    // Primary key WITHOUT a DB default: the app layer is expected to supply a value
    // (e.g. Prisma @default(uuid()) on a text column). Generate a UUID by default so
    // the NOT NULL constraint is satisfied. User can change it.
    if (col.__isPk) return 'uuid_v4';

    // Strong overrides: enum types and FK columns are handled by the caller
    // (it sets fk_pick / enum and supplies pool/values). We still hint here.
    if (Array.isArray(col.enum_values) && col.enum_values.length > 0) return 'enum';
    if (col.__isFk) return 'fk_pick';

    if (type === 'uuid') return 'uuid_v4';
    if (type === 'boolean') return 'bool';
    if (type === 'date') return has('birth') || has('dob') ? 'dob' : 'date';
    if (type === 'time' || type === 'time without time zone' || type === 'time with time zone') return 'time';
    if (type.includes('timestamp')) return has('birth') ? 'dob' : 'datetime_iso';
    if (type === 'json' || type === 'jsonb') return 'json_obj';
    if (type === 'inet' || type === 'cidr') return 'ipv4';
    if (type === 'macaddr' || type === 'macaddr8') return 'mac';

    // name-based
    if (has('email')) return 'email';
    if (has('first_name') || has('firstname') || (has('first') && has('name'))) return 'first_name';
    if (has('last_name') || has('lastname') || (has('last') && has('name')) || has('surname')) return 'last_name';
    if (has('username') || has('user_name') || has('login') || has('handle')) return 'username';
    if (has('full_name') || name === 'name') return 'full_name';
    if (has('gender') || has('sex')) return 'gender';
    if (has('dob') || has('birth')) return 'dob';
    if (has('age')) return 'age';
    if (has('national_id') || has('ssn') || has('nin')) return 'national_id';
    if (has('phone') || has('mobile') || has('tel')) return 'phone_e164';
    if (has('zip') || has('postcode') || has('postal')) return 'zip_us';
    if (has('country')) return 'country';
    if (has('city')) return 'city';
    if (has('street')) return 'street';
    if (has('address')) return 'address';
    if (has('timezone') || has('tz')) return 'timezone';
    if (has('lat')) return 'lat';
    if (has('lon') || has('lng')) return 'lon';
    if (has('ipv6')) return 'ipv6';
    if (has('ip')) return 'ipv4';
    if (has('mac')) return 'mac';
    if (has('user_agent') || has('useragent') || has('ua')) return 'user_agent';
    if (has('domain')) return 'domain';
    if (has('url') || has('link') || has('href') || has('website') || has('site')) return 'url';
    if (has('port')) return 'port';
    if (has('method') && has('http')) return 'http_method';
    if (has('status') && (has('http') || has('code'))) return 'http_status';
    if (has('dns')) return 'dns_record';
    if (has('totp') || has('otp_secret')) return 'totp_secret';
    if (has('password_hash') || has('passwd_hash') || has('pwhash')) return 'password_bcrypt_like';
    if (has('password') || has('passwd')) return 'password_plain';
    if (has('api_key') || has('apikey') || has('token')) return 'api_key';
    if (has('jwt')) return 'jwt_like';
    if (has('uuid') || has('guid')) return 'uuid_v4';
    if (has('slug')) return 'slug';
    if (has('color')) return 'hex_color';
    if (has('lang') || has('locale')) return 'enum'; // user can fill
    if (has('description') || has('bio') || has('about') || has('body') || has('content')) return 'paragraph';
    if (has('title') || has('subject') || has('headline')) return 'sentence';
    if (has('tags')) return 'tags_csv';
    if (has('created_at') || has('updated_at') || has('inserted_at') || has('modified_at') || has('timestamp')) return 'datetime_iso';

    if (type.includes('int')) return 'int';
    if (type.includes('numeric') || type.includes('decimal') || type.includes('real') || type.includes('double')) return 'float';
    if (type.includes('char') || type === 'text') return 'word';

    return 'default';
  }

  // ---------- runtime ----------
  async function generateRows({ columns, count, plan }) {
    // plan: { [columnName]: { id, opts } }
    const out = [];
    for (let i = 0; i < count; i++) {
      const row = {};
      for (const c of columns) {
        const p = plan[c.column_name];
        if (!p || p.id === 'default') { /* leave undefined -> DEFAULT */ continue; }
        const gDef = G.find(x => x.id === p.id);
        if (!gDef) continue;
        let v;
        if (gDef.async) v = await gDef.gen({ i, total: count, opts: p.opts || {} });
        else v = gDef.gen({ i, total: count, opts: p.opts || {} });
        if (v === undefined) continue;
        row[c.column_name] = v;
      }
      out.push(row);
    }
    return out;
  }

  function listByCategory() {
    const cats = new Map();
    for (const g of G) {
      if (!cats.has(g.category)) cats.set(g.category, []);
      cats.get(g.category).push(g);
    }
    return [...cats.entries()];
  }

  global.PBGen = {
    generators: G,
    listByCategory,
    autoDetect,
    generateRows,
    getById: (id) => G.find(g => g.id === id),
  };
})(window);
