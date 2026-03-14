import { PeerServer } from 'peer';
import http from 'http';

// Railway сам выдаёт PORT — обязательно читать из env
const PORT = process.env.PORT || 9000;

const server = http.createServer((req, res) => {
  // Healthcheck — Railway и мониторинг стучат сюда
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'SecureGram Signal',
      peers: getCount(),
      ts: Date.now()
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const peerServer = PeerServer({
  server,
  path: '/signal',
  proxied: true,           // за Railway reverse proxy
  allow_discovery: false,  // не показывать список пиров
  alive_timeout: 60000,
  cleanup_out_msgs: 1000,
});

peerServer.on('connection', (client) => {
  console.log(`[+] ${client.getId()} | peers: ${getCount()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[-] ${client.getId()} | peers: ${getCount()}`);
});

peerServer.on('error', (err) => {
  console.error('[!]', err.message);
});

function getCount() {
  try { return peerServer._clients?.size ?? '?'; }
  catch { return '?'; }
}

server.listen(PORT, () => {
  console.log(`SecureGram Signal Server запущен на порту ${PORT}`);
  console.log(`Healthcheck: /health`);
  console.log(`WebSocket:   /signal`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
