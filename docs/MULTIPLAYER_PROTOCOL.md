# Multiplayer (P2P over WebSocket) — Сетевой слой и протокол

## Цель
Минимальный протокол обмена позициями игроков через WebSocket‑сервер (сигналинг/релей).

## Топология
- Транспорт: WebSocket.
- Сервер: принимает подключения, раздает `peerId`, ретранслирует `state` в рамках комнаты.
- Клиенты напрямую друг с другом не общаются.

## Модель сессии
- **roomId**: строка, клиент указывает комнату при подключении (`hello`).
- **peerId**: строка, выдается сервером при `hello/hello-ack`.
- **Подключение**:
  1) Клиент открывает WS.
  2) Отправляет `hello` с `roomId`.
  3) Сервер отвечает `hello` (ack) с присвоенным `peerId` и текущим списком peers (опционально).
- **Отключение**:
  - Клиент отправляет `leave`, затем закрывает WS.
  - Сервер рассылает `leave` всем в комнате.
- **Timeout**:
  - Клиент отправляет `ping` каждые 5 секунд.
  - Если сервер не получает `ping`/`state` от peer > 15 секунд, он удаляет peer и рассылает `leave`.

## Частота обновлений
- Рекомендуемая частота: **10–20 сообщений/сек** (`state`).
- Клиент не должен превышать 20 `state`/сек.

## Контракт данных позиции
`state` содержит:
- `id`: `string` (peerId).
- `position`: `{ x: number, y: number, z: number }`.
- `direction`: `{ x: number, y: number, z: number }` (нормализованный вектор взгляда/движения).
- `timestamp`: `number` (ms, `Date.now()` на стороне отправителя).

## Формат сообщений (JSON)
Все сообщения имеют общий формат:
```
{
  "type": "<message-type>",
  "roomId": "string",
  "payload": { ... }
}
```

### `hello` (client → server)
```
{
  "type": "hello",
  "roomId": "room-1",
  "payload": {
    "clientVersion": "string"
  }
}
```

### `hello` (server → client, ack)
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

### `state` (client → server → room)
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

### `leave` (client → server) / (server → room)
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

### `ping` (client → server)
```
{
  "type": "ping",
  "roomId": "room-1",
  "payload": {
    "timestamp": 1700000000000
  }
}
```

### `pong` (server → client)
```
{
  "type": "pong",
  "roomId": "room-1",
  "payload": {
    "timestamp": 1700000000000
  }
}
```

## Поведение при подключении/отключении
- После `hello` сервер обязан вернуть `peerId`.
- Сервер обязан расслать `leave` по факту закрытия WS или по таймауту.
- Клиент должен удалять удаленного игрока при `leave`.

