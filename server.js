const express = require('express');
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

// ── Storage ──────────────────────────────────────────────
// signals[peerId] = [{ from, data, ts }]
const signals = {};
// pollers[peerId] = { res, timer }  — active long-poll connections
const pollers = {};

const POLL_TIMEOUT = 20000; // 20s
const SIGNAL_TTL   = 60000; // 1 min
const MAX_SIGNALS  = 100;

function gid() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 10);
}

// cleanup stale signals every 30s
setInterval(() => {
  const now = Date.now();
  for (const id in signals) {
    signals[id] = signals[id].filter(s => now - s.ts < SIGNAL_TTL);
    if (!signals[id].length) delete signals[id];
  }
}, 30000);

// ── GET /id ───────────────────────────────────────────────
app.get('/id', (req, res) => {
  res.json({ id: gid() });
});

// ── GET /health ───────────────────────────────────────────
app.get('/health', (req, res) => {
  const peers = Object.keys(pollers).length;
  const queued = Object.values(signals).reduce((a, b) => a + b.length, 0);
  res.json({ ok: true, service: 'LIDERS CHAT signal', peers, queued });
});
app.get('/', (req, res) => res.redirect('/health'));

// ── POST /signal ──────────────────────────────────────────
// Body: { to, from, data }
app.post('/signal', (req, res) => {
  const { to, from, data } = req.body;
  if (!to || !from || !data) { res.status(400).json({ error: 'bad request' }); return; }

  // If target is long-polling right now — deliver immediately
  if (pollers[to]) {
    const { res: pollRes, timer } = pollers[to];
    clearTimeout(timer);
    delete pollers[to];
    pollRes.json({ signals: [{ from, data }] });
    res.json({ ok: true, delivered: 'immediate' });
    return;
  }

  // Otherwise queue
  if (!signals[to]) signals[to] = [];
  signals[to].push({ from, data, ts: Date.now() });
  if (signals[to].length > MAX_SIGNALS) signals[to].shift();

  res.json({ ok: true, delivered: 'queued' });
});

// ── GET /poll/:peerId ─────────────────────────────────────
app.get('/poll/:peerId', (req, res) => {
  const peerId = req.params.peerId;
  if (!peerId) { res.status(400).json({ error: 'no id' }); return; }

  // Close any existing poll for this peer
  if (pollers[peerId]) {
    clearTimeout(pollers[peerId].timer);
    pollers[peerId].res.json({ signals: [] });
    delete pollers[peerId];
  }

  // Check if we already have queued signals
  if (signals[peerId] && signals[peerId].length > 0) {
    const pending = signals[peerId];
    delete signals[peerId];
    res.json({ signals: pending });
    return;
  }

  // Hold the connection
  const timer = setTimeout(() => {
    if (pollers[peerId]) {
      delete pollers[peerId];
      res.json({ signals: [] });
    }
  }, POLL_TIMEOUT);

  pollers[peerId] = { res, timer };

  req.on('close', () => {
    if (pollers[peerId] && pollers[peerId].res === res) {
      clearTimeout(timer);
      delete pollers[peerId];
    }
  });
});

// ── Offline message relay ─────────────────────────────────
const offlineQueue = {};
const RELAY_TTL = 7 * 24 * 3600 * 1000;

app.post('/relay', (req, res) => {
  const { to, msgs } = req.body;
  if (!to || !Array.isArray(msgs)) { res.status(400).json({}); return; }
  if (!offlineQueue[to]) offlineQueue[to] = [];
  msgs.forEach(m => {
    if (m.id && m.cipher) offlineQueue[to].push({ ...m, storedAt: Date.now() });
  });
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

app.listen(PORT, () => console.log(`LIDERS CHAT signal :${PORT} (HTTP long-polling)`));
process.on('SIGTERM', () => process.exit(0));
