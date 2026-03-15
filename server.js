import { PeerServer } from 'peer';
import http from 'http';

const PORT = process.env.PORT || 9000;

// ═══════════════════════════════════════════
//  OFFLINE MESSAGE STORE
//  Сервер хранит зашифрованные сообщения.
//  Расшифровать их может только получатель.
// ═══════════════════════════════════════════

const queue = new Map(); // peerId -> [{id, cipher, from, roomId, storedAt}]
const MAX_PER_PEER = 500;
const TTL = 7 * 24 * 60 * 60 * 1000; // 7 дней

function queueMsg(to, msg) {
  if (!queue.has(to)) queue.set(to, []);
  const q = queue.get(to);
  // Deduplicate by id
  if (msg.id && q.find(m => m.id === msg.id)) return;
  q.push({ ...msg, storedAt: Date.now() });
  if (q.length > MAX_PER_PEER) q.splice(0, q.length - MAX_PER_PEER);
}

function fetchQueue(peerId) {
  const q = (queue.get(peerId) || []).filter(m => Date.now() - m.storedAt < TTL);
  queue.delete(peerId);
  return q;
}

// Cleanup every hour
setInterval(() => {
  let peers = 0, msgs = 0;
  for (const [id, q] of queue.entries()) {
    const fresh = q.filter(m => Date.now() - m.storedAt < TTL);
    if (!fresh.length) queue.delete(id);
    else { queue.set(id, fresh); peers++; msgs += fresh.length; }
  }
  if (peers) console.log(`[cleanup] ${peers} peers, ${msgs} msgs`);
}, 3600000);

// ═══════════════════════════════════════════
//  HTTP SERVER
// ═══════════════════════════════════════════

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://x`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health
  if (url.pathname === '/' || url.pathname === '/health') {
    let total = 0; queue.forEach(q => total += q.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'LIDERS CHAT', peers: getCount(), queued: total }));
    return;
  }

  // POST /relay — store msgs for offline peer
  // Body: { to: "peerID", msgs: [{id, cipher, from, roomId}] }
  if (url.pathname === '/relay' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 3000000) { res.writeHead(413); res.end(); } });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.to || !Array.isArray(data.msgs)) { res.writeHead(400); res.end('{}'); return; }
        let n = 0;
        data.msgs.forEach(m => { if (m.id && m.cipher) { queueMsg(data.to, m); n++; } });
        console.log(`[relay] +${n} msgs for ${data.to.slice(0,8)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, stored: n }));
      } catch(e) { res.writeHead(400); res.end('{}'); }
    });
    return;
  }

  // GET /relay?peer=ID — fetch and clear queue
  if (url.pathname === '/relay' && req.method === 'GET') {
    const peerId = url.searchParams.get('peer');
    if (!peerId) { res.writeHead(400); res.end('{}'); return; }
    const msgs = fetchQueue(peerId);
    console.log(`[relay] delivered ${msgs.length} msgs to ${peerId.slice(0,8)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msgs }));
    return;
  }

  res.writeHead(404); res.end('{}');
});

// ═══════════════════════════════════════════
//  PEER SERVER
// ═══════════════════════════════════════════

const peerServer = PeerServer({
  server, path: '/signal', proxied: true,
  allow_discovery: false, alive_timeout: 60000, cleanup_out_msgs: 1000,
});

peerServer.on('connection', c => console.log(`[+] ${c.getId()} peers:${getCount()}`));
peerServer.on('disconnect', c => console.log(`[-] ${c.getId()} peers:${getCount()}`));
peerServer.on('error', e => console.error('[err]', e.message));

function getCount() { try { return peerServer._clients?.size ?? '?'; } catch { return '?'; } }

server.listen(PORT, () => console.log(`LIDERS CHAT Signal :${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
