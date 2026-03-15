const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const PORT = process.env.PORT || 9000;
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '3mb' }));

const httpServer = createServer(app);

// Socket.io with polling fallback — works even when WebSocket is blocked
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Allow both WebSocket and long-polling
  transports: ['websocket', 'polling'],
  // Polling settings for blocked WS environments
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  allowUpgrades: true,
});

// ═══════════════════════════════════════════
//  PEER REGISTRY
// ═══════════════════════════════════════════
const peers = new Map(); // peerId -> socketId
const sockets = new Map(); // socketId -> peerId

// ═══════════════════════════════════════════
//  OFFLINE MESSAGE QUEUE
// ═══════════════════════════════════════════
const queue = new Map(); // peerId -> [{id, cipher, from, roomId, storedAt}]
const MAX_Q = 500;
const TTL = 7 * 24 * 3600 * 1000;

function queueMsg(to, msg) {
  if (!queue.has(to)) queue.set(to, []);
  const q = queue.get(to);
  if (msg.id && q.find(m => m.id === msg.id)) return;
  q.push({ ...msg, storedAt: Date.now() });
  if (q.length > MAX_Q) q.splice(0, q.length - MAX_Q);
}
function fetchQueue(peerId) {
  const q = (queue.get(peerId) || []).filter(m => Date.now() - m.storedAt < TTL);
  queue.delete(peerId);
  return q;
}
setInterval(() => {
  let total = 0;
  for (const [id, q] of queue.entries()) {
    const fresh = q.filter(m => Date.now() - m.storedAt < TTL);
    if (!fresh.length) queue.delete(id);
    else { queue.set(id, fresh); total += fresh.length; }
  }
}, 3600000);

// ═══════════════════════════════════════════
//  SOCKET.IO SIGNALING
// ═══════════════════════════════════════════
io.on('connection', (socket) => {
  let myPeerId = null;

  // Register peer
  socket.on('register', (peerId) => {
    if (!peerId) return;
    myPeerId = peerId;
    peers.set(peerId, socket.id);
    sockets.set(socket.id, peerId);
    console.log(`[+] ${peerId.slice(0,8)} peers:${peers.size} transport:${socket.conn.transport.name}`);

    // Deliver queued messages
    const queued = fetchQueue(peerId);
    if (queued.length > 0) {
      socket.emit('queued', queued);
      console.log(`[relay] delivered ${queued.length} msgs to ${peerId.slice(0,8)}`);
    }
  });

  // Signal relay: forward to target peer
  socket.on('signal', ({ to, data }) => {
    const targetSocketId = peers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', { from: myPeerId, data });
    } else {
      // Target offline - queue if it's a message
      if (data && data.type === 'msg' && data.cipher) {
        queueMsg(to, { id: data.id, cipher: data.cipher, from: myPeerId, roomId: data.roomId });
      }
      socket.emit('peer_offline', { peerId: to });
    }
  });

  socket.on('disconnect', () => {
    if (myPeerId) {
      peers.delete(myPeerId);
      sockets.delete(socket.id);
      console.log(`[-] ${myPeerId.slice(0,8)} peers:${peers.size}`);
    }
  });
});

// ═══════════════════════════════════════════
//  HTTP ENDPOINTS
// ═══════════════════════════════════════════

app.get('/', (req, res) => {
  let total = 0; queue.forEach(q => total += q.length);
  res.json({ ok: true, service: 'LIDERS CHAT', peers: peers.size, queued: total, ts: Date.now() });
});

app.get('/health', (req, res) => {
  let total = 0; queue.forEach(q => total += q.length);
  res.json({ ok: true, service: 'LIDERS CHAT', peers: peers.size, queued: total });
});

// Legacy HTTP relay (fallback)
app.post('/relay', (req, res) => {
  const { to, msgs } = req.body;
  if (!to || !Array.isArray(msgs)) { res.status(400).json({}); return; }
  let n = 0;
  msgs.forEach(m => { if (m.id && m.cipher) { queueMsg(to, m); n++; } });
  // Try to deliver immediately if online
  const sid = peers.get(to);
  if (sid) { io.to(sid).emit('queued', msgs); }
  console.log(`[relay/http] +${n} for ${to.slice(0,8)}`);
  res.json({ ok: true, stored: n });
});

app.get('/relay', (req, res) => {
  const peerId = req.query.peer;
  if (!peerId) { res.status(400).json({}); return; }
  const msgs = fetchQueue(peerId);
  res.json({ ok: true, msgs });
});

httpServer.listen(PORT, () => {
  console.log(`LIDERS CHAT Signal :${PORT}`);
  console.log(`Transports: WebSocket + HTTP long-polling (bypass WS blocks)`);
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT', () => httpServer.close(() => process.exit(0)));
