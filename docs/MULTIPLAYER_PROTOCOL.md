# Multiplayer (P2P over WebSocket) - Network Layer and Protocol

## Purpose
Minimal protocol for exchanging player positions through a WebSocket server (signaling/relay).

## Topology
- Transport: WebSocket.
- Server: accepts connections, assigns `peerId`, relays `state` within a room.
- Clients do not communicate directly with each other.

## Session model
- **roomId**: string, provided by the client on connection (`hello`).
- **peerId**: string, assigned by the server on `hello/hello-ack`.
- **Connect**:
  1) Client opens WS.
  2) Sends `hello` with `roomId`.
  3) Server replies `hello` (ack) with assigned `peerId` and current peers list (optional).
- **Disconnect**:
  - Client sends `leave`, then closes WS.
  - Server broadcasts `leave` to the room.
- **Timeout**:
  - Client sends `ping` every 5 seconds.
  - If the server does not receive `ping`/`state` from a peer for > 15 seconds, it removes the peer and broadcasts `leave`.

## Update rate
- Recommended rate: **10-20 messages/sec** (`state`).
- Client should not exceed 20 `state`/sec.

## Position data contract
`state` contains:
- `id`: `string` (peerId).
- `position`: `{ x: number, y: number, z: number }`.
- `direction`: `{ x: number, y: number, z: number }` (normalized view/movement vector).
- `timestamp`: `number` (ms, `Date.now()` on sender).

## Message format (JSON)
All messages share the common format:
```
{
  "type": "<message-type>",
  "roomId": "string",
  "payload": { ... }
}
```

### `hello` (client -> server)
```
{
  "type": "hello",
  "roomId": "room-1",
  "payload": {
    "clientVersion": "string"
  }
}
```

### `hello` (server -> client, ack)
```
{
  "type": "hello",
  "roomId": "room-1",
  "payload": {
    "peerId": "peer-123",
    "peers": ["peer-456", "peer-789"]
  }
}
```

### `state` (client -> server -> room)
```
{
  "type": "state",
  "roomId": "room-1",
  "payload": {
    "id": "peer-123",
    "position": { "x": 0, "y": 1, "z": 2 },
    "direction": { "x": 0, "y": 0, "z": 1 },
    "timestamp": 1700000000000
  }
}
```

### `leave` (client -> server) / (server -> room)
```
{
  "type": "leave",
  "roomId": "room-1",
  "payload": {
    "id": "peer-123",
    "reason": "client_close | timeout"
  }
}
```

### `ping` (client -> server)
```
{
  "type": "ping",
  "roomId": "room-1",
  "payload": {
    "timestamp": 1700000000000
  }
}
```

### `pong` (server -> client)
```
{
  "type": "pong",
  "roomId": "room-1",
  "payload": {
    "timestamp": 1700000000000
  }
}
```

## Connect/disconnect behavior
- After `hello`, the server must return a `peerId`.
- The server must broadcast `leave` on WS close or timeout.
- The client must remove the remote player on `leave`.
