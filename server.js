import { PeerServer } from 'peer';

const PORT = process.env.PORT || 9000;

const peerServer = PeerServer({
  port: PORT,
  path: '/signal',
  proxied: true,
  allow_discovery: false,
  alive_timeout: 60000,
  cleanup_out_msgs: 1000,
  key: 'peerjs',
});

peerServer.on('connection', (client) => {
  console.log(`[+] ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[-] ${client.getId()}`);
});

console.log(`Signal Server running on port ${PORT}`);

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
