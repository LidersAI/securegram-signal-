const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:C9ZDC0bQj4Wl3JJv@db.iivmtdjflstyzexuxwxu.supabase.co:5432/postgres';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL,
      backup_hash TEXT NOT NULL, backup_salt TEXT NOT NULL,
      peer_id TEXT NOT NULL UNIQUE, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, username TEXT NOT NULL,
      peer_id TEXT NOT NULL, expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      room_id TEXT PRIMARY KEY, host_id TEXT NOT NULL,
      name TEXT NOT NULL, emoji TEXT DEFAULT '👥',
      pin TEXT DEFAULT '', is_channel BOOLEAN DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      room_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      display_name TEXT NOT NULL, joined_at BIGINT NOT NULL,
      PRIMARY KEY (room_id, peer_id)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL,
      from_id TEXT NOT NULL, from_name TEXT NOT NULL,
      cipher TEXT NOT NULL, msg_date TEXT NOT NULL,
      msg_ts TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gm_room ON group_messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  `);
  console.log('[db] PostgreSQL connected (Supabase)');
}

function hashPassword(p, s) { return crypto.pbkdf2Sync(p, s, 100000, 64, 'sha256').toString('hex'); }
function hashBackupCode(c, s) { return crypto.pbkdf2Sync(c.toUpperCase(), s, 10000, 32, 'sha256').toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function generateBackupCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 12; i++) { if (i===4||i===8) code+='-'; code+=chars[crypto.randomInt(chars.length)]; }
  return code;
}

setInterval(async () => { try { await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]); } catch(e){} }, 3600000);

// Auth
app.get('/check/:username', async (req, res) => {
  try { const r = await pool.query('SELECT 1 FROM accounts WHERE username=$1', [req.params.username.toLowerCase()]); res.json({ taken: r.rows.length > 0 }); }
  catch(e) { res.status(500).json({ error: 'db error' }); }
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
    await pool.query('INSERT INTO accounts (username,display_name,password_hash,salt,backup_hash,backup_salt,peer_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [userLower, username, passwordHash, salt, backupHash, backupSalt, userLower, Date.now()]);
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, userLower, Date.now() + 30*24*3600*1000]);
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
    if (hashPassword(password, account.salt) !== account.password_hash) { res.status(401).json({ error: 'Неверный пароль' }); return; }
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, account.peer_id, Date.now() + 30*24*3600*1000]);
    console.log(`[login] ${account.display_name}`);
    res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name });
  } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/guest', (req, res) => res.json({ ok: true, peerId: 'g-' + crypto.randomBytes(8).toString('hex') }));

app.post('/recover', async (req, res) => {
  const { username, backupCode, newPassword } = req.body || {};
  if (!username || !backupCode || !newPassword) { res.status(400).json({ error: 'Заполните все поля' }); return; }
  const userLower = username.toLowerCase();
  try {
    const r = await pool.query('SELECT * FROM accounts WHERE username=$1', [userLower]);
    if (!r.rows.length) { res.status(404).json({ error: 'Аккаунт не найден' }); return; }
    const account = r.rows[0];
    if (hashBackupCode(backupCode, account.backup_salt) !== account.backup_hash) { res.status(401).json({ error: 'Неверный код' }); return; }
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newPassHash = hashPassword(newPassword, newSalt);
    const newBackup = generateBackupCode();
    const newBackupSalt = crypto.randomBytes(16).toString('hex');
    const newBackupHash = hashBackupCode(newBackup, newBackupSalt);
    await pool.query('UPDATE accounts SET password_hash=$1, salt=$2, backup_hash=$3, backup_salt=$4 WHERE username=$5',
      [newPassHash, newSalt, newBackupHash, newBackupSalt, userLower]);
    const token = generateToken();
    await pool.query('INSERT INTO sessions (token,username,peer_id,expires_at) VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO UPDATE SET expires_at=$4',
      [token, userLower, account.peer_id, Date.now() + 30*24*3600*1000]);
    res.json({ ok: true, token, peerId: account.peer_id, username: account.display_name, newBackupCode: newBackup });
  } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Groups API
app.post('/group', async (req, res) => {
  const { roomId, hostId, name, emoji, pin, isChannel } = req.body || {};
  if (!roomId || !hostId || !name) { res.status(400).json({ error: 'bad' }); return; }
  try {
    await pool.query(`INSERT INTO groups (room_id,host_id,name,emoji,pin,is_channel,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (room_id) DO UPDATE SET name=$3,emoji=$4,pin=$5`,
      [roomId, hostId, name, emoji||'👥', pin||'', isChannel||false, Date.now()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/group/:roomId', async (req, res) => {
  try {
    const g = await pool.query('SELECT * FROM groups WHERE room_id=$1', [req.params.roomId]);
    if (!g.rows.length) { res.status(404).json({ error: 'not found' }); return; }
    const m = await pool.query('SELECT * FROM group_members WHERE room_id=$1', [req.params.roomId]);
    res.json({ ok: true, group: g.rows[0], members: m.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/group/:roomId/join', async (req, res) => {
  const { peerId, displayName } = req.body || {};
  if (!peerId) { res.status(400).json({ error: 'bad' }); return; }
  try {
    await pool.query(`INSERT INTO group_members (room_id,peer_id,display_name,joined_at) VALUES ($1,$2,$3,$4) ON CONFLICT (room_id,peer_id) DO UPDATE SET display_name=$3`,
      [req.params.roomId, peerId, displayName||peerId, Date.now()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/group/:roomId/msg', async (req, res) => {
  const { id, fromId, fromName, cipher, msgDate, msgTs } = req.body || {};
  if (!id || !fromId || !cipher) { res.status(400).json({ error: 'bad' }); return; }
  try {
    await pool.query(`INSERT INTO group_messages (id,room_id,from_id,from_name,cipher,msg_date,msg_ts,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [id, req.params.roomId, fromId, fromName||fromId, cipher, msgDate||'', msgTs||'', Date.now()]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/group/:roomId/msgs', async (req, res) => {
  const since = parseInt(req.query.since) || 0;
  try {
    const r = await pool.query('SELECT * FROM group_messages WHERE room_id=$1 AND created_at>$2 ORDER BY created_at ASC LIMIT 100',
      [req.params.roomId, since]);
    res.json({ ok: true, msgs: r.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Signaling - short poll (8s) to keep server awake
const signals = {}, pollers = {};
const POLL_TIMEOUT = 8000, SIGNAL_TTL = 60000, MAX_SIGNALS = 100;
const rateLimits = {};

function checkRate(ip, type) {
  const key = ip+':'+type, now = Date.now();
  if (!rateLimits[key] || now > rateLimits[key].resetAt) rateLimits[key] = {count:0, resetAt:now+60000};
  return ++rateLimits[key].count <= (type==='signal' ? 120 : 120);
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

// Relay
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
