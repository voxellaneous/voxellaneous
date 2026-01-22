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

## MULTIPLAYER (P2P WEBRTC)

### Local запуск

1) Запуск сигналинг‑сервера WebSocket:

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
Данные позиций идут напрямую через WebRTC DataChannel, сервер используется только для сигналинга.

### Прод режим

- Сигналинг‑сервер должен быть доступен по публичному WS URL.
- Фронтенд подключается по `VITE_WS_URL` и `VITE_WS_ROOM`.
- Данные идут напрямую peer‑to‑peer через WebRTC.

### Параметры окружения

Сервер (`voxellaneous-server`):
- `PORT` — порт сервера (по умолчанию 8080).
- `DEFAULT_ROOM` — комната по умолчанию (по умолчанию `lobby`).
- `TIMEOUT_MS` — таймаут неактивного peer (по умолчанию 15000).
- `CLEANUP_INTERVAL_MS` — интервал проверки таймаутов (по умолчанию 5000).
- `MAX_PEERS` — максимум peers в комнате (по умолчанию 8).

Фронтенд (`voxellaneous-web`):
- `VITE_WS_URL` — URL сигналинг‑сервера (по умолчанию `ws://<host>:8080`).
- `VITE_WS_ROOM` — room id (по умолчанию `lobby`).

### Чек‑лист ручной проверки

1) Открыть две вкладки/браузера с одним `VITE_WS_ROOM`.
2) Убедиться, что соединение установлено и видны удаленные маркеры.
3) Закрыть одну вкладку и проверить, что peer удаляется.
4) Оставить вкладку без активности и проверить очистку по таймауту.
