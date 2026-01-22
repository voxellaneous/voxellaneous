'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || 'lobby';
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS || '15000', 10);
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.CLEANUP_INTERVAL_MS || '5000', 10);

const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map(); // roomId -> Map(peerId -> peer)
let peerCounter = 0;

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function generatePeerId() {
  peerCounter += 1;
  return `peer-${peerCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(data) {
  try {
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

function sendJson(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(roomId, message, excludePeerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [peerId, peer] of room.entries()) {
    if (excludePeerId && peerId === excludePeerId) continue;
    sendJson(peer.ws, message);
  }
}

function removePeer(peer, reason) {
  if (!peer || !peer.roomId || !peer.peerId) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;

  if (room.has(peer.peerId)) {
    room.delete(peer.peerId);
    broadcast(peer.roomId, {
      type: 'leave',
      roomId: peer.roomId,
      payload: {
        id: peer.peerId,
        reason,
      },
    }, peer.peerId);
  }

  if (room.size === 0) {
    rooms.delete(peer.roomId);
  }

  peer.peerId = null;
  peer.roomId = null;
}

function handleHello(peer, message) {
  const roomId = (message.roomId || DEFAULT_ROOM).toString();
  const room = getRoom(roomId);

  if (!peer.peerId) {
    peer.peerId = generatePeerId();
  }

  peer.roomId = roomId;
  peer.lastSeen = Date.now();
  room.set(peer.peerId, peer);

  const peers = Array.from(room.keys()).filter((id) => id !== peer.peerId);

  sendJson(peer.ws, {
    type: 'hello',
    roomId,
    payload: {
      peerId: peer.peerId,
      peers,
    },
  });
}

function handleState(peer, message) {
  if (!peer.peerId || !peer.roomId) return;
  const room = rooms.get(peer.roomId);
  if (!room || !room.has(peer.peerId)) return;
  peer.lastSeen = Date.now();

  const payload = message.payload || {};
  const id = payload.id;
  if (typeof id !== 'string' || id !== peer.peerId) {
    return;
  }

  broadcast(peer.roomId, {
    type: 'state',
    roomId: peer.roomId,
    payload,
  }, peer.peerId);
}

function handleLeave(peer, message) {
  if (!peer.peerId || !peer.roomId) return;
  peer.lastSeen = Date.now();
  const reason = message && message.payload && message.payload.reason;
  removePeer(peer, reason || 'client_close');
}

function handlePing(peer, message) {
  if (!peer.peerId || !peer.roomId) return;
  peer.lastSeen = Date.now();
  sendJson(peer.ws, {
    type: 'pong',
    roomId: peer.roomId,
    payload: {
      timestamp: Date.now(),
    },
  });
}

function handleMessage(peer, data) {
  const message = safeJsonParse(data);
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'hello':
      handleHello(peer, message);
      break;
    case 'state':
      handleState(peer, message);
      break;
    case 'leave':
      handleLeave(peer, message);
      break;
    case 'ping':
      handlePing(peer, message);
      break;
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  const peer = {
    ws,
    peerId: null,
    roomId: null,
    lastSeen: Date.now(),
  };

  ws.on('message', (data) => {
    handleMessage(peer, data);
  });

  ws.on('close', () => {
    removePeer(peer, 'client_close');
  });

  ws.on('error', () => {
    removePeer(peer, 'client_error');
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const peer of room.values()) {
      if (now - peer.lastSeen > TIMEOUT_MS) {
        try {
          peer.ws.terminate();
        } catch (error) {
          // ignore
        }
        removePeer(peer, 'timeout');
      }
    }
  }
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`WS server listening on :${PORT}`);
});
