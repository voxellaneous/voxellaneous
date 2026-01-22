# VOXELLANEOUS

## BUILD

### WGPU RENDERER BACKEND (RUST -> WASM MODULE)

in voxellaneous-core:

```
wasm-pack build --target web
```

### FRONTEND (TYPESCRIPT)

in voxellaneous-web:

```
npm install
npm run dev
```

## MULTIPLAYER

### Local запуск

1) Запуск сервера WebSocket:

```
cd voxellaneous-server
npm install
npm run start
```

2) Запуск фронтенда:

```
cd voxellaneous-web
npm install
npm run dev
```

По умолчанию фронтенд подключается к `ws://<host>:8080` и комнате `lobby`.

### Прод режим

- Сервер WebSocket должен быть доступен по публичному WS URL.
- Фронтенд подключается по `VITE_WS_URL` и `VITE_WS_ROOM`.

### Параметры окружения

Сервер (`voxellaneous-server`):
- `PORT` — порт сервера (по умолчанию 8080).
- `DEFAULT_ROOM` — комната по умолчанию (по умолчанию `lobby`).
- `TIMEOUT_MS` — таймаут неактивного peer (по умолчанию 15000).
- `CLEANUP_INTERVAL_MS` — интервал проверки таймаутов (по умолчанию 5000).

Фронтенд (`voxellaneous-web`):
- `VITE_WS_URL` — URL WebSocket сервера (по умолчанию `ws://<host>:8080`).
- `VITE_WS_ROOM` — room id (по умолчанию `lobby`).
