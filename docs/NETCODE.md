# Сетевой кодек (Netcode)

Этот документ описывает бинарный формат сетевых сообщений, используемых клиентом и сервером.
Кодеки реализованы в `voxellaneous-common/src/netcode.ts` и используются обеими сторонами.

## Общие принципы
- Формат бинарный, little‑endian.
- Сообщения передаются через raw‑канал Geckos (`channel.raw.emit(...)`, `channel.onRaw(...)`).
- Все числа — фиксированного размера, чтобы упростить парсинг и снизить нагрузку.

## UserCmd (ввод игрока)
**Размер**: 13 байт.

**Layout**:
```
[Keys u8] [ViewDir.x f32] [ViewDir.y f32] [ViewDir.z f32]
```

**Битовая маска Keys**:
- 0x01 — forward
- 0x02 — backward
- 0x04 — left
- 0x08 — right
- 0x10 — jump
- 0x20 — descend

**Кодеки**:
- `encodeUserCmd(cmd): ArrayBuffer`
- `decodeUserCmd(buffer): UserCmd`

## WorldSnapshot (снимок мира)
**Header**:
```
[Timestamp f64] [Count u16]
```

**Entity (фиксированный размер 44 байта)**:
```
[Id u32]
[Pos.x i32] [Pos.y i32] [Pos.z i32]
[Vel.x i32] [Vel.y i32] [Vel.z i32]
[Rot.x f32] [Rot.y f32] [Rot.z f32] [Rot.w f32]
```

### Квантование
Позиции и скорости кодируются как `int32` с масштабом:
- `SNAPSHOT_POS_SCALE = 100` (1 единица = 1 см)
- `SNAPSHOT_VEL_SCALE = 100`

**Диапазон** при `scale = 100`: примерно ±21 474 км по каждой оси.

### Кодеки
- `encodeWorldSnapshot(snapshot): ArrayBuffer`
- `decodeWorldSnapshot(buffer): WorldSnapshot`

## ID игроков
- `EntityState.id` — это `u32` (числовой идентификатор), выдаётся сервером при подключении.
- В снапшотах ID всегда фиксированного размера (4 байта).

## Совместимость
- Клиент и сервер используют единый кодек из `voxellaneous-common/src/netcode.ts`.
- Любое изменение формата должно происходить в этом файле, чтобы не было рассинхрона.
