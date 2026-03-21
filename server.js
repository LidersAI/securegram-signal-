const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ═══════════════════════════════════════════
//  DATABASE (SQLite)
// ═══════════════════════════════════════════
const DB_PATH = process.env.DB_PATH || path.join('/tmp', 'liders.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    username      TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    backup_hash   TEXT NOT NULL,
    backup_salt   TEXT NOT NULL,
    peer_id       TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    peer_id     TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

console.log(`[db] SQLite at ${DB_PATH}`);

// Prepared statements
const stmts = {
  getAccount:    db.prepare('SELECT * FROM accounts WHERE username = ?'),
  createAccount: db.prepare('INSERT INTO accounts (username, display_name, password_hash, salt, backup_hash, backup_salt, peer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updatePassword:db.prepare('UPDATE accounts SET password_hash = ?, salt = ?, backup_hash = ?, backup_salt = ? WHERE username = ?'),
  createSession: db.prepare('INSERT OR REPLACE INTO sessions (token, username, peer_id, expires_at) VALUES (?, ?, ?, ?)'),
  getSession:    db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
  cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  countAccounts: db.prepare('SELECT COUNT(*) as c FROM accounts'),
};

// Cleanup expired sessions every hour
setInterval(() => {
  const deleted = stmts.cleanSessions.run(Date.now()).changes;
  if (deleted > 0) console.log(`[db] cleaned ${deleted} expired sessions`);
}, 3600000);

// ── Crypto helpers ─────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}

function hashBackupCode(code, salt) {
  return crypto.pbkdf2Sync(code.toUpperCase(), salt, 10000, 32, 'sha256').toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateBackupCode() {
  // Human-readable 12-char code: XXXX-XXXX-XXXX
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }
  return code; // e.g. "ABCD-EFGH-JKLM"
}

// ═══════════════════════════════════════════
//  ACCOUNTS API
// ═══════════════════════════════════════════

// GET /check/:username
app.get('/check/:username', (req, res) => {
  const userLower = req.params.username.toLowerCase();
  const exists = !!stmts.getAccount.get(userLower);
  res.json({ taken: exists });
});

// POST /register
app.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }
  if (username.length < 3 || username.length > 32) { res.status(400).json({ error: 'Имя 3–32 символа' }); return; }
  if (!/^[a-zA-Z0-9_а-яёА-ЯЁ]+$/.test(username)) { res.status(400).json({ error: 'Только буквы, цифры, _' }); return; }
  if (password.length < 4) { res.status(400).json({ error: 'Пароль минимум 4 символа' }); return; }

  const userLower = username.toLowerCase();
  if (stmts.getAccount.get(userLower)) { res.status(409).json({ error: 'Имя уже занято' }); return; }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const backupCode = generateBackupCode();
  const backupSalt = crypto.randomBytes(16).toString('hex');
  const backupHash = hashBackupCode(backupCode, backupSalt);
  const peerId = userLower;

  stmts.createAccount.run(userLower, username, passwordHash, salt, backupHash, backupSalt, peerId, Date.now());

  const token = generateToken();
  stmts.createSession.run(token, userLower, peerId, Date.now() + 30 * 24 * 3600 * 1000);

  console.log(`[+] registered: ${username}`);
  // Return backup code ONCE — never stored in plaintext again
  res.json({ ok: true, token, peerId, username, backupCode });
});

// POST /login
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }

  const userLower = username.toLowerCase();
  const account = stmts.getAccount.get(userLower);
  if (!account) { res.status(401).json({ error: 'Аккаунт не найден' }); return; }

  const hash = hashPassword(password, account.salt);
  if (hash !== account.password_hash) { res.status(401).json({ error: 'Неверный пароль' }); return; }

  const token = generateToken();
  stmts.createSession.run(token, userLower, account.peer_id, Date.now() + 30 * 24 * 3600 * 1000);

  console.log(`[login] ${account.display_name}`);
  res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name });
});

// POST /guest
app.post('/guest', (req, res) => {
  const peerId = 'g-' + crypto.randomBytes(8).toString('hex');
  res.json({ ok: true, peerId });
});

// POST /recover
app.post('/recover', (req, res) => {
  const { username, backupCode, newPassword } = req.body || {};
  if (!username || !backupCode || !newPassword) { res.status(400).json({ error: 'Заполните все поля' }); return; }
  if (newPassword.length < 4) { res.status(400).json({ error: 'Пароль минимум 4 символа' }); return; }

  const userLower = username.toLowerCase();
  const account = stmts.getAccount.get(userLower);
  if (!account) { res.status(404).json({ error: 'Аккаунт не найден' }); return; }

  // Verify backup code
  const inputHash = hashBackupCode(backupCode, account.backup_salt);
  if (inputHash !== account.backup_hash) { res.status(401).json({ error: 'Неверный код восстановления' }); return; }

  // Update password + generate new backup code
  const newSalt = crypto.randomBytes(16).toString('hex');
  const newPassHash = hashPassword(newPassword, newSalt);
  const newBackup = generateBackupCode();
  const newBackupSalt = crypto.randomBytes(16).toString('hex');
  const newBackupHash = hashBackupCode(newBackup, newBackupSalt);

  stmts.updatePassword.run(newPassHash, newSalt, newBackupHash, newBackupSalt, userLower);

  const token = generateToken();
  stmts.createSession.run(token, userLower, account.peer_id, Date.now() + 30 * 24 * 3600 * 1000);

  console.log(`[recover] ${account.display_name}`);
  res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name, newBackupCode: newBackup });
});

// ═══════════════════════════════════════════
//  SIGNALING (HTTP long-polling)
// ═══════════════════════════════════════════
const signals = {};
const pollers = {};
const POLL_TIMEOUT = 20000;
const SIGNAL_TTL = 60000;
const MAX_SIGNALS = 100;

// Rate limiting
const rateLimits = {};
function checkRate(ip, type) {
  const key = ip + ':' + type;
  const now = Date.now();
  if (!rateLimits[key] || now > rateLimits[key].resetAt) rateLimits[key] = { count: 0, resetAt: now + 60000 };
  rateLimits[key].count++;
  return rateLimits[key].count <= (type === 'signal' ? 120 : 60);
}
setInterval(() => { const now=Date.now(); for(const k in rateLimits) if(now>rateLimits[k].resetAt) delete rateLimits[k]; }, 120000);
setInterval(() => { const now=Date.now(); for(const id in signals) { signals[id]=signals[id].filter(m=>now-m.ts<SIGNAL_TTL); if(!signals[id].length) delete signals[id]; } }, 30000);

app.get('/id', (req, res) => {
  const id = Math.random().toString(36).slice(2,10) + Math.random().toString(36).slice(2,10);
  res.json({ id });
});

app.post('/signal', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  if (!checkRate(ip, 'signal')) { res.status(429).json({ error: 'rate limit' }); return; }
  const { to, from, data } = req.body;
  if (!to || !from || !data) { res.status(400).json({ error: 'bad request' }); return; }
  if (pollers[to]) {
    const { res: pr, timer } = pollers[to];
    clearTimeout(timer); delete pollers[to];
    pr.json({ signals: [{ from, data }] });
    res.json({ ok: true, delivered: 'immediate' }); return;
  }
  if (!signals[to]) signals[to] = [];
  signals[to].push({ from, data, ts: Date.now() });
  if (signals[to].length > MAX_SIGNALS) signals[to].shift();
  res.json({ ok: true, delivered: 'queued' });
});

app.get('/poll/:peerId', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  if (!checkRate(ip, 'poll')) { res.status(429).json({ error: 'rate limit' }); return; }
  const peerId = req.params.peerId;
  if (!peerId || peerId.length > 64 || !/^[a-zA-Z0-9_а-яёА-ЯЁ-]+$/i.test(peerId)) {
    res.status(400).json({ error: 'invalid id' }); return;
  }
  if (pollers[peerId]) { clearTimeout(pollers[peerId].timer); pollers[peerId].res.json({ signals: [] }); delete pollers[peerId]; }
  if (signals[peerId]?.length > 0) {
    const pending = signals[peerId]; delete signals[peerId];
    res.json({ signals: pending }); return;
  }
  const timer = setTimeout(() => { if (pollers[peerId]) { delete pollers[peerId]; res.json({ signals: [] }); } }, POLL_TIMEOUT);
  pollers[peerId] = { res, timer };
  req.on('close', () => { if (pollers[peerId]?.res === res) { clearTimeout(timer); delete pollers[peerId]; } });
});

// ═══════════════════════════════════════════
//  OFFLINE RELAY
// ═══════════════════════════════════════════
const offlineQueue = {};
const RELAY_TTL = 7 * 24 * 3600 * 1000;

app.post('/relay', (req, res) => {
  const { to, msgs } = req.body;
  if (!to || !Array.isArray(msgs)) { res.status(400).json({}); return; }
  if (!offlineQueue[to]) offlineQueue[to] = [];
  msgs.forEach(m => { if (m.id && m.cipher) offlineQueue[to].push({ ...m, storedAt: Date.now() }); });
  if (offlineQueue[to].length > 500) offlineQueue[to].splice(0, offlineQueue[to].length - 500);
  res.json({ ok: true });
});

app.get('/relay', (req, res) => {
  const peerId = req.query.peer;
  if (!peerId) { res.status(400).json({}); return; }
  const msgs = (offlineQueue[peerId] || []).filter(m => Date.now() - m.storedAt < RELAY_TTL);
  delete offlineQueue[peerId];
  res.json({ ok: true, msgs });
});

// ═══════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════
app.get('/health', (req, res) => {
  const { c } = stmts.countAccounts.get();
  let queued = 0; Object.values(offlineQueue).forEach(q => queued += q.length);
  res.json({ ok: true, service: 'LIDERS CHAT', accounts: c, online: Object.keys(pollers).length, queued });
});
app.get('/', (req, res) => res.redirect('/health'));

app.listen(PORT, () => console.log(`LIDERS CHAT Signal :${PORT} (SQLite ${DB_PATH})`));
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
