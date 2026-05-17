const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Map<peerId, ws>
const rooms = new Map();

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PhoneConf server running on http://localhost:${PORT}`));
