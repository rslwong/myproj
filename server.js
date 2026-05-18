const express    = require('express');
const WebSocket  = require('ws');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const selfsigned = require('selfsigned');
const qr         = require('qrcode-terminal');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);

async function loadOrCreateCert() {
  const SSL_KEY  = process.env.SSL_KEY;
  const SSL_CERT = process.env.SSL_CERT;
  if (SSL_KEY && SSL_CERT) {
    return { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) };
  }

  // Auto-generate and cache a self-signed cert so it survives restarts
  const dir      = path.join(__dirname, '.ssl');
  const keyFile  = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  console.log('Generating self-signed certificate (one-time)…');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    days: 3650,
    keySize: 2048,
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile,  pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert,    { mode: 0o644 });
  console.log('Certificate saved to .ssl/ — reused on future restarts.');
  return { key: pems.private, cert: pems.cert };
}

// roomId -> Map<peerId, ws>
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

(async () => {
  const credentials = await loadOrCreateCert();
  const server = https.createServer(credentials, app);

  // Redirect plain HTTP → HTTPS so mobile browsers land on the secure origin
  const HTTP_PORT = parseInt(process.env.HTTP_PORT || '80', 10);
  http.createServer((req, res) => {
    const host = req.headers.host ? req.headers.host.replace(/:\d+$/, '') : 'localhost';
    const url  = PORT === 443
      ? `https://${host}${req.url}`
      : `https://${host}:${PORT}${req.url}`;
    res.writeHead(301, { Location: url });
    res.end();
  }).listen(HTTP_PORT, () => console.log(`HTTP → HTTPS redirect on port ${HTTP_PORT}`))
    .on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        console.warn(`Could not bind HTTP redirect on port ${HTTP_PORT}: ${err.message}`);
      }
    });

  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    let currentRoom = null;
    let currentPeer = null;

    function broadcast(roomId, msg, excludePeer = null) {
      const room = rooms.get(roomId);
      if (!room) return;
      const data = JSON.stringify(msg);
      for (const [pid, sock] of room) {
        if (pid !== excludePeer && sock.readyState === WebSocket.OPEN) {
          sock.send(data);
        }
      }
    }

    function send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'create-room': {
          let roomId;
          do { roomId = generateRoomId(); } while (rooms.has(roomId));
          currentPeer = msg.peerId;
          currentRoom = roomId;
          rooms.set(roomId, new Map([[currentPeer, ws]]));
          send({ type: 'room-created', roomId });
          break;
        }

        case 'join-room': {
          const { roomId, peerId } = msg;
          if (!rooms.has(roomId)) {
            send({ type: 'error', message: 'Room not found. Check the code and try again.' });
            return;
          }
          currentPeer = peerId;
          currentRoom = roomId;
          const room = rooms.get(roomId);
          const existingPeers = Array.from(room.keys());
          room.set(peerId, ws);
          send({ type: 'room-joined', roomId, peers: existingPeers });
          broadcast(roomId, { type: 'peer-joined', peerId }, peerId);
          break;
        }

        // WebRTC signaling — forward to target peer
        case 'offer':
        case 'answer':
        case 'ice-candidate': {
          const { targetPeerId, ...rest } = msg;
          if (!currentRoom) return;
          const room = rooms.get(currentRoom);
          const targetWs = room && room.get(targetPeerId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ ...rest, fromPeerId: currentPeer }));
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const room = rooms.get(currentRoom);
      room.delete(currentPeer);
      broadcast(currentRoom, { type: 'peer-left', peerId: currentPeer });
      if (room.size === 0) rooms.delete(currentRoom);
    });
  });

  server.listen(PORT, () => {
    // Find a non-loopback IPv4 address so the phone can reach this machine
    const lanIp = Object.values(os.networkInterfaces())
      .flat()
      .find(iface => iface.family === 'IPv4' && !iface.internal)
      ?.address ?? 'localhost';

    const url = `https://${lanIp}:${PORT}`;
    console.log(`PhoneConf server running on ${url}`);
    console.log('\nScan to open on your phone (accept the cert warning once):');
    qr.generate(url, { small: true });
  });
})();
