# P2P (WebRTC DataChannel) - Architecture and Signaling

## Purpose
Move from a WS relay to P2P exchange via WebRTC DataChannel. The WS server is used only for signaling.

## Topology
- **Mesh**: each client connects to every other client.
- **Limits**: recommended max 8 peers per room (quadratic connection growth).
- **Rooms**: roomId is provided by the client on `join`.

## WS server role
- Signaling only: `join/leave/offer/answer/ice/ping/pong`.
- No relay of `state` or any gameplay data.

## Connection states
- `connecting`: establishing WS and WebRTC, waiting for offer/answer/ICE.
- `connected`: DataChannel open and sending/receiving `state`.
- `disconnected`: connection is down, DataChannel closed.
- `reconnecting`: attempting to restore WS/RTC.

## Timeout policy
- Client sends WS `ping` every 5 seconds.
- If no signaling from a peer for > 15 seconds, the peer is considered disconnected and `leave` is issued.
- On DataChannel drop, transition to `reconnecting`.

## Signaling messages (JSON)
Common format:
```
{
  "type": "<message-type>",
  "roomId": "string",
  "payload": { ... }
}
```

### `join` (client -> server)
```
{
  "type": "join",
  "roomId": "room-1",
  "payload": {
    "clientId": "string"
  }
}
```

### `leave` (client -> server -> room)
```
{
  "type": "leave",
  "roomId": "room-1",
  "payload": {
    "clientId": "string",
    "reason": "client_close | timeout"
  }
}
```

### `offer` / `answer` (client <-> server <-> target)
```
{
  "type": "offer",
  "roomId": "room-1",
  "payload": {
    "from": "peer-1",
    "to": "peer-2",
    "sdp": "string"
  }
}
```

```
{
  "type": "answer",
  "roomId": "room-1",
  "payload": {
    "from": "peer-2",
    "to": "peer-1",
    "sdp": "string"
  }
}
```

### `ice` (client <-> server <-> target)
```
{
  "type": "ice",
  "roomId": "room-1",
  "payload": {
    "from": "peer-1",
    "to": "peer-2",
    "candidate": "string"
  }
}
```

### `ping` / `pong` (client <-> server)
```
{
  "type": "ping",
  "roomId": "room-1",
  "payload": { "timestamp": 1700000000000 }
}
```

```
{
  "type": "pong",
  "roomId": "room-1",
  "payload": { "timestamp": 1700000000000 }
}
```

## `state` contract for DataChannel
Sent directly peer-to-peer at **10-20 Hz**.

```
{
  "type": "state",
  "payload": {
    "id": "peer-1",
    "position": { "x": 0, "y": 1, "z": 2 },
    "direction": { "x": 0, "y": 0, "z": 1 },
    "timestamp": 1700000000000
  }
}
```
