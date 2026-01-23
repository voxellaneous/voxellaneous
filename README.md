# VOXELLANEOUS

## BUILD

### WGPU RENDERER BACKEND (RUST -> WASM MODULE)

In voxellaneous-core:

```
wasm-pack build --target web
```

### FRONTEND (TYPESCRIPT)

In voxellaneous-web:

```
npm install
npm run dev
```

## MULTIPLAYER (P2P WEBRTC)

### Local run

1) Start the WebSocket signaling server:

```
cd voxellaneous-server
npm install
npm run dev
```

2) Start the frontend:

```
cd voxellaneous-web
npm install
npm run dev
```

By default the frontend connects to `ws://<host>:8080` and room `lobby`.
Position data flows directly through the WebRTC DataChannel; the server is only for signaling.
The signaling server is TypeScript and lives in this monorepo as a subfolder.

### Production

- The signaling server must be reachable via a public WS URL.
- The frontend connects via `VITE_WS_URL` and `VITE_WS_ROOM`.
- Data flows directly peer-to-peer via WebRTC.

### Environment variables

Server (`voxellaneous-server`):
- `PORT` - server port (default 8080).
- `DEFAULT_ROOM` - default room (default `lobby`).
- `TIMEOUT_MS` - inactive peer timeout (default 15000).
- `CLEANUP_INTERVAL_MS` - timeout check interval (default 5000).
- `MAX_PEERS` - max peers per room (default 8).

Frontend (`voxellaneous-web`):
- `VITE_WS_URL` - signaling server URL (default `ws://<host>:8080`).
- `VITE_WS_ROOM` - room id (default `lobby`).

### Manual test checklist

1) Open two tabs/browsers with the same `VITE_WS_ROOM`.
2) Verify the connection is established and remote markers are visible.
3) Close one tab and confirm the peer is removed.
4) Leave a tab idle and verify timeout cleanup.
