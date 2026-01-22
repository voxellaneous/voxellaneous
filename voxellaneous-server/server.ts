import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

type Peer = {
  ws: WebSocket;
  peerId: string | null;
  roomId: string | null;
  lastSeen: number;
};

type SignalingMessage = {
  type?: unknown;
  roomId?: unknown;
  payload?: unknown;
};

type TargetPayload = {
  to?: unknown;
  sdp?: unknown;
  candidate?: unknown;
};

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || 'lobby';
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS || '15000', 10);
const CLEANUP_INTERVAL_MS = Number.parseInt(process.env.CLEANUP_INTERVAL_MS || '5000', 10);
const MAX_PEERS = Number.parseInt(process.env.MAX_PEERS || '8', 10);

const server = http.createServer();
const wss = new WebSocketServer({ server });

const rooms = new Map<string, Map<string, Peer>>();
let peerCounter = 0;

function getRoom(roomId: string): Map<string, Peer> {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId)!;
}

function generatePeerId(): string {
  peerCounter += 1;
  return `peer-${peerCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeJsonParse(data: string): SignalingMessage | null {
  try {
    return JSON.parse(data) as SignalingMessage;
  } catch {
    return null;
  }
}

function sendJson(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(roomId: string, message: unknown, excludePeerId?: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [peerId, peer] of room.entries()) {
    if (excludePeerId && peerId === excludePeerId) continue;
    sendJson(peer.ws, message);
  }
}

function removePeer(peer: Peer, reason: string): void {
  if (!peer.roomId || !peer.peerId) return;
  const room = rooms.get(peer.roomId);
  if (!room) return;

  if (room.has(peer.peerId)) {
    room.delete(peer.peerId);
    broadcast(
      peer.roomId,
      {
        type: 'leave',
        roomId: peer.roomId,
        payload: {
          id: peer.peerId,
          reason,
        },
      },
      peer.peerId,
    );
  }

  if (room.size === 0) {
    rooms.delete(peer.roomId);
  }

  peer.peerId = null;
  peer.roomId = null;
}

function handleJoin(peer: Peer, message: SignalingMessage): void {
  const roomId = (message.roomId || DEFAULT_ROOM).toString();
  const room = getRoom(roomId);

  if (room.size >= MAX_PEERS) {
    sendJson(peer.ws, {
      type: 'join',
      roomId,
      payload: {
        error: 'room_full',
      },
    });
    return;
  }

  if (!peer.peerId) {
    peer.peerId = generatePeerId();
  }

  peer.roomId = roomId;
  peer.lastSeen = Date.now();
  room.set(peer.peerId, peer);

  const peers = Array.from(room.keys()).filter((id) => id !== peer.peerId);

  sendJson(peer.ws, {
    type: 'join',
    roomId,
    payload: {
      peerId: peer.peerId,
      peers,
    },
  });

  broadcast(
    roomId,
    {
      type: 'join',
      roomId,
      payload: {
        peerId: peer.peerId,
      },
    },
    peer.peerId,
  );
}

function handleLeave(peer: Peer, message: SignalingMessage): void {
  if (!peer.peerId || !peer.roomId) return;
  peer.lastSeen = Date.now();
  const payload = message.payload as { reason?: unknown } | undefined;
  const reason = payload && typeof payload.reason === 'string' ? payload.reason : 'client_close';
  removePeer(peer, reason);
}

function handlePing(peer: Peer): void {
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

function forwardToPeer(peer: Peer, message: SignalingMessage, type: string): void {
  if (!peer.peerId || !peer.roomId) return;
  const payload = message.payload as TargetPayload | undefined;
  if (!payload || typeof payload.to !== 'string') return;

  const room = rooms.get(peer.roomId);
  if (!room) return;
  const target = room.get(payload.to);
  if (!target) return;

  sendJson(target.ws, {
    type,
    roomId: peer.roomId,
    payload: {
      from: peer.peerId,
      to: payload.to,
      sdp: typeof payload.sdp === 'string' ? payload.sdp : undefined,
      candidate: typeof payload.candidate === 'string' ? payload.candidate : undefined,
    },
  });
}

function handleMessage(peer: Peer, data: WebSocket.RawData): void {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const message = safeJsonParse(text);
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'join':
      handleJoin(peer, message);
      break;
    case 'leave':
      handleLeave(peer, message);
      break;
    case 'offer':
      forwardToPeer(peer, message, 'offer');
      break;
    case 'answer':
      forwardToPeer(peer, message, 'answer');
      break;
    case 'ice':
      forwardToPeer(peer, message, 'ice');
      break;
    case 'ping':
      handlePing(peer);
      break;
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  const peer: Peer = {
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
        } catch {
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
