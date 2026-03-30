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

## MULTIPLAYER (AUTHORITATIVE SERVER)

### Local run

1) Start the Geckos authoritative server:

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

By default the frontend connects to `http://<host>:8080` (Geckos/WebRTC).
The server is authoritative: clients send inputs, the server simulates and broadcasts snapshots.
See `docs/NETCODE.md` and `docs/MULTIPLAYER_PROTOCOL.md` for the binary formats and protocol.

### Production

- The server must be reachable via a public URL.
- Frontend connects to the server host (Geckos manages WebRTC internally).

### Environment variables

Server (`voxellaneous-server`):
- `PORT` - server port (default 8080).
- `PLAYER_TIMEOUT_MS` - inactive player timeout (default 300000).

### Manual test checklist

1) Open two tabs/browsers.
2) Verify the connection is established and remote markers are visible.
3) Close one tab and confirm the player is removed.
4) Leave a tab idle and verify timeout cleanup.
