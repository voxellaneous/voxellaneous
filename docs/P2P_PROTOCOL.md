# P2P (WebRTC DataChannel) — Архитектура и сигналинг

## Цель
Перейти от WS‑релея к P2P‑обмену через WebRTC DataChannel. WS‑сервер используется только для сигналинга.

## Топология
- **Mesh**: каждый клиент устанавливает соединение с каждым.
- **Ограничения**: рекомендуется максимум 8 peers в комнате (из‑за квадратичного роста соединений).
- **Комнаты**: roomId задается клиентом при `join`.

## Роль WS‑сервера
- Только сигналинг: `join/leave/offer/answer/ice/ping/pong`.
- Нет ретрансляции `state` и любых игровых данных.

## Состояния соединения
- `connecting`: установление WS и WebRTC, ожидание offer/answer/ICE.
- `connected`: DataChannel открыт и принимает/отправляет `state`.
- `disconnected`: соединение разорвано, DataChannel закрыт.
- `reconnecting`: попытки восстановить WS/RTC.

## Политика таймаутов
- Клиент отправляет `ping` на WS раз в 5 секунд.
- Если от peer нет signaling‑сообщений > 15 секунд — peer считается отключенным, выполняется `leave`.
- При разрыве DataChannel — переход в `reconnecting`.

## Сигналинговые сообщения (JSON)
Общий формат:
```
{
  "type": "<message-type>",
  "roomId": "string",
  "payload": { ... }
}
```

### `join` (client → server)
```
{
  "type": "join",
  "roomId": "room-1",
  "payload": {
    "clientId": "string"
  }
}
```

### `leave` (client → server → room)
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

### `offer` / `answer` (client ↔ server ↔ target)
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

### `ice` (client ↔ server ↔ target)
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

### `ping` / `pong` (client ↔ server)
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

## Контракт `state` для DataChannel
Отправляется напрямую peer‑to‑peer, частота **10–20 Hz**.

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

