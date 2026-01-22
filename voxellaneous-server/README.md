# voxellaneous-server

Minimal WebSocket server for signaling (no state relay).

## Run

```bash
npm install
npm run start
```

## Environment variables

- `PORT` - server port (default 8080).
- `DEFAULT_ROOM` - default room (default "lobby").
- `TIMEOUT_MS` - inactive peer timeout (default 15000).
- `CLEANUP_INTERVAL_MS` - timeout check interval (default 5000).
- `MAX_PEERS` - max peers per room (default 8).

## Notes

- The server only provides signaling (join/leave/offer/answer/ice).
