const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
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
//  DATABASE (PostgreSQL / Supabase)
// ═══════════════════════════════════════════
const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:C9ZDC0bQj4Wl3JJv@db.iivmtdjflstyzexuxwxu.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username      TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      backup_hash   TEXT NOT NULL,
      backup_salt   TEXT NOT NULL,
      peer_id       TEXT NOT NULL UNIQUE,
      created_at    BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      peer_id     TEXT NOT NULL,
      expires_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  console.log('[db] PostgreSQL connected (Supabase)');
}

// ── Crypto ─────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex');
}
function hashBackupCode(code, salt) {
  return crypto.pbkdf2Sync(code.toUpperCase(), salt, 10000, 32, 'sha256').toString('hex');
}
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateBackupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) {
    if (i === 4 || i === 8) code += '-';
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

// Cleanup expired sessions every hour
setInterval(async () => {
  try { await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]); }
  catch(e) {}
}, 3600000);

// ═══════════════════════════════════════════
//  ACCOUNTS API
// ═══════════════════════════════════════════

app.get('/check/:username', async (req, res) => {
  try {
    const u = req.params.username.toLowerCase();
    const r = await pool.query('SELECT 1 FROM accounts WHERE username=$1', [u]);
    res.json({ taken: r.rows.length > 0 });
  } catch(e) { res.status(500).json({ error: 'db error' }); }
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }
  if (username.length < 3 || username.length > 32) { res.status(400).json({ error: 'Имя 3–32 символа' }); return; }
  if (!/^[a-zA-Z0-9_а-яёА-ЯЁ]+$/.test(username)) { res.status(400).json({ error: 'Только буквы, цифры, _' }); return; }
  if (password.length < 4) { res.status(400).json({ error: 'Пароль минимум 4 символа' }); return; }

  const userLower = username.toLowerCase();
  try {
    const exists = await pool.query('SELECT 1 FROM accounts WHERE username=$1', [userLower]);
    if (exists.rows.length) { res.status(409).json({ error: 'Имя уже занято' }); return; }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const backupCode = generateBackupCode();
    const backupSalt = crypto.randomBytes(16).toString('hex');
    const backupHash = hashBackupCode(backupCode, backupSalt);

    await pool.query(
      'INSERT INTO accounts (username,display_name,password_hash,salt,backup_hash,backup_salt,peer_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userLower, username, passwordHash, salt, backupHash, backupSalt, userLower, Date.now()]
    );

    const token = generateToken();
    await pool.query(
      'INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, userLower, Date.now() + 30*24*3600*1000]
    );

    console.log(`[+] registered: ${username}`);
    res.json({ ok: true, token, peerId: userLower, username, backupCode });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) { res.status(400).json({ error: 'Укажите имя и пароль' }); return; }

  const userLower = username.toLowerCase();
  try {
    const r = await pool.query('SELECT * FROM accounts WHERE username=$1', [userLower]);
    if (!r.rows.length) { res.status(401).json({ error: 'Аккаунт не найден' }); return; }
    const account = r.rows[0];

    const hash = hashPassword(password, account.salt);
    if (hash !== account.password_hash) { res.status(401).json({ error: 'Неверный пароль' }); return; }

    const token = generateToken();
    await pool.query(
      'INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, account.peer_id, Date.now() + 30*24*3600*1000]
    );

    console.log(`[login] ${account.display_name}`);
    res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name });
  } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/guest', (req, res) => {
  res.json({ ok: true, peerId: 'g-' + crypto.randomBytes(8).toString('hex') });
});

app.post('/recover', async (req, res) => {
  const { username, backupCode, newPassword } = req.body || {};
  if (!username || !backupCode || !newPassword) { res.status(400).json({ error: 'Заполните все поля' }); return; }
  if (newPassword.length < 4) { res.status(400).json({ error: 'Пароль минимум 4 символа' }); return; }

  const userLower = username.toLowerCase();
  try {
    const r = await pool.query('SELECT * FROM accounts WHERE username=$1', [userLower]);
    if (!r.rows.length) { res.status(404).json({ error: 'Аккаунт не найден' }); return; }
    const account = r.rows[0];

    const inputHash = hashBackupCode(backupCode, account.backup_salt);
    if (inputHash !== account.backup_hash) { res.status(401).json({ error: 'Неверный код восстановления' }); return; }

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newPassHash = hashPassword(newPassword, newSalt);
    const newBackup = generateBackupCode();
    const newBackupSalt = crypto.randomBytes(16).toString('hex');
    const newBackupHash = hashBackupCode(newBackup, newBackupSalt);

    await pool.query(
      'UPDATE accounts SET password_hash=$1, salt=$2, backup_hash=$3, backup_salt=$4 WHERE username=$5',
      [newPassHash, newSalt, newBackupHash, newBackupSalt, userLower]
    );

    const token = generateToken();
    await pool.query(
      'INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, account.peer_id, Date.now() + 30*24*3600*1000]
    );

    res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name, newBackupCode: newBackup });
  } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ═══════════════════════════════════════════
//  SIGNALING
// ═══════════════════════════════════════════
const signals = {}, pollers = {};
const POLL_TIMEOUT = 20000, SIGNAL_TTL = 60000, MAX_SIGNALS = 100;
const rateLimits = {};

function checkRate(ip, type) {
  const key = ip+':'+type, now = Date.now();
  if (!rateLimits[key] || now > rateLimits[key].resetAt) rateLimits[key] = {count:0, resetAt:now+60000};
  return ++rateLimits[key].count <= (type==='signal' ? 120 : 60);
}
setInterval(() => { const now=Date.now(); for(const k in rateLimits) if(now>rateLimits[k].resetAt) delete rateLimits[k]; }, 120000);
setInterval(() => { const now=Date.now(); for(const id in signals) { signals[id]=signals[id].filter(m=>now-m.ts<SIGNAL_TTL); if(!signals[id].length) delete signals[id]; }}, 30000);

app.get('/id', (req, res) => res.json({ id: Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10) }));

app.post('/signal', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  if (!checkRate(ip,'signal')) { res.status(429).json({error:'rate limit'}); return; }
  const {to,from,data} = req.body;
  if (!to||!from||!data) { res.status(400).json({error:'bad'}); return; }
  if (pollers[to]) {
    const {res:pr,timer} = pollers[to]; clearTimeout(timer); delete pollers[to];
    pr.json({signals:[{from,data}]}); res.json({ok:true,delivered:'immediate'}); return;
  }
  if (!signals[to]) signals[to]=[];
  signals[to].push({from,data,ts:Date.now()});
  if (signals[to].length>MAX_SIGNALS) signals[to].shift();
  res.json({ok:true,delivered:'queued'});
});

app.get('/poll/:peerId', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  if (!checkRate(ip,'poll')) { res.status(429).json({error:'rate limit'}); return; }
  const peerId = req.params.peerId;
  if (!peerId||peerId.length>64||!/^[a-zA-Z0-9_а-яёА-ЯЁ-]+$/i.test(peerId)) { res.status(400).json({error:'invalid'}); return; }
  if (pollers[peerId]) { clearTimeout(pollers[peerId].timer); pollers[peerId].res.json({signals:[]}); delete pollers[peerId]; }
  if (signals[peerId]?.length>0) { const p=signals[peerId]; delete signals[peerId]; res.json({signals:p}); return; }
  const timer = setTimeout(()=>{ if(pollers[peerId]){delete pollers[peerId];res.json({signals:[]});} }, POLL_TIMEOUT);
  pollers[peerId] = {res,timer};
  req.on('close',()=>{ if(pollers[peerId]?.res===res){clearTimeout(timer);delete pollers[peerId];} });
});

// ═══════════════════════════════════════════
//  RELAY
// ═══════════════════════════════════════════
const offlineQueue = {};
const RELAY_TTL = 7*24*3600*1000;

app.post('/relay', (req,res) => {
  const {to,msgs} = req.body;
  if (!to||!Array.isArray(msgs)) { res.status(400).json({}); return; }
  if (!offlineQueue[to]) offlineQueue[to]=[];
  msgs.forEach(m=>{ if(m.id&&m.cipher) offlineQueue[to].push({...m,storedAt:Date.now()}); });
  if (offlineQueue[to].length>500) offlineQueue[to].splice(0,offlineQueue[to].length-500);
  res.json({ok:true});
});

app.get('/relay', (req,res) => {
  const peerId=req.query.peer; if(!peerId){res.status(400).json({});return;}
  const msgs=(offlineQueue[peerId]||[]).filter(m=>Date.now()-m.storedAt<RELAY_TTL);
  delete offlineQueue[peerId];
  res.json({ok:true,msgs});
});

// ═══════════════════════════════════════════
//  HEALTH + START
// ═══════════════════════════════════════════
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as c FROM accounts');
    let q=0; Object.values(offlineQueue).forEach(x=>q+=x.length);
    res.json({ok:true, service:'LIDERS CHAT', accounts:parseInt(r.rows[0].c), online:Object.keys(pollers).length, queued:q});
  } catch(e) { res.json({ok:false, error:e.message}); }
});
app.get('/', (req,res) => res.redirect('/health'));

initDB().then(() => {
  app.listen(PORT, () => console.log(`LIDERS CHAT Signal :${PORT} (Supabase PostgreSQL)`));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });

process.on('SIGTERM', () => { pool.end(); process.exit(0); });
process.on('SIGINT',  () => { pool.end(); process.exit(0); });
