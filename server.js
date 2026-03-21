const express = require('express');
const crypto = require('crypto');
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
//  ACCOUNTS
//  username -> { passwordHash, salt, peerId, createdAt }
// ═══════════════════════════════════════════
const accounts = {};    // username -> account
const sessions = {};    // token -> { username, peerId, expiresAt }
const peerToUser = {};  // peerId -> username

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateToken(token) {
  const s = sessions[token];
  if (!s) return null;
  if (Date.now() > s.expiresAt) { delete sessions[token]; return null; }
  return s;
}

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const t in sessions) if (now > sessions[t].expiresAt) delete sessions[t];
}, 3600000);

// ── POST /register ────────────────────────────────────────
// Body: { username, password }
// Returns: { ok, token, peerId }
app.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }
  if (username.length < 3 || username.length > 32) { res.status(400).json({ error: 'Имя 3–32 символа' }); return; }
  if (!/^[a-zA-Z0-9_а-яёА-ЯЁ]+$/.test(username)) { res.status(400).json({ error: 'Только буквы, цифры, _' }); return; }
  if (password.length < 4) { res.status(400).json({ error: 'Пароль минимум 4 символа' }); return; }

  const userLower = username.toLowerCase();
  if (accounts[userLower]) { res.status(409).json({ error: 'Имя уже занято' }); return; }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const peerId = userLower + '-' + crypto.randomBytes(4).toString('hex');

  accounts[userLower] = { username, passwordHash, salt, peerId, createdAt: Date.now() };
  peerToUser[peerId] = userLower;

  const token = generateToken();
  sessions[token] = { username, peerId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 }; // 30 days

  console.log(`[+] registered: ${username} -> ${peerId}`);
  res.json({ ok: true, token, peerId, username });
});

// ── POST /login ───────────────────────────────────────────
// Body: { username, password }
// Returns: { ok, token, peerId }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }

  const userLower = username.toLowerCase();
  const account = accounts[userLower];
  if (!account) { res.status(401).json({ error: 'Аккаунт не найден' }); return; }

  const hash = hashPassword(password, account.salt);
  if (hash !== account.passwordHash) { res.status(401).json({ error: 'Неверный пароль' }); return; }

  const token = generateToken();
  sessions[token] = { username: account.username, peerId: account.peerId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };

  console.log(`[login] ${account.username}`);
  res.json({ ok: true, token, peerId: account.peerId, username: account.username });
});

// ── POST /guest ───────────────────────────────────────────
// Returns: { ok, peerId } — anonymous session, no account
app.post('/guest', (req, res) => {
  const peerId = 'g-' + crypto.randomBytes(8).toString('hex');
  res.json({ ok: true, peerId });
});

// ── GET /check/:username ──────────────────────────────────
app.get('/check/:username', (req, res) => {
  const taken = !!accounts[req.params.username.toLowerCase()];
  res.json({ taken });
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

function gid() { return Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10); }

app.get('/id', (req, res) => res.json({ id: gid() }));

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
  if (!peerId || peerId.length > 64 || !/^[a-zA-Z0-9_а-яёА-ЯЁ-]+$/.test(peerId)) { res.status(400).json({ error: 'invalid id' }); return; }
  if (pollers[peerId]) { clearTimeout(pollers[peerId].timer); pollers[peerId].res.json({ signals: [] }); delete pollers[peerId]; }
  if (signals[peerId] && signals[peerId].length > 0) {
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
  let total = 0; Object.values(offlineQueue).forEach(q => total += q.length);
  res.json({ ok: true, service: 'LIDERS CHAT', accounts: Object.keys(accounts).length, online: Object.keys(pollers).length, queued: total });
});
app.get('/', (req, res) => res.redirect('/health'));

app.listen(PORT, () => console.log(`LIDERS CHAT Signal :${PORT}`));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
