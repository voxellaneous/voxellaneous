# voxellaneous-server

Minimal WebSocket signaling server (TypeScript, no state relay).

## Run

```bash
npm install
npm run dev
```

## Environment variables

- `PORT` - server port (default 8080).
- `DEFAULT_ROOM` - default room (default "lobby").
- `TIMEOUT_MS` - inactive peer timeout (default 15000).
- `CLEANUP_INTERVAL_MS` - timeout check interval (default 5000).
- `MAX_PEERS` - max peers per room (default 8).

## Notes

- This server lives in the monorepo as a subfolder.
- The server only provides signaling (join/leave/offer/answer/ice).
