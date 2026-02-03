export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type Quaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type UserCmd = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  descend: boolean;
  viewDir: Vector3;
};

export type EntityState = {
  id: number;
  position: Vector3;
  velocity: Vector3;
  rotation: Quaternion;
};

export type WorldSnapshot = {
  timestamp: number;
  sequence: number;
  lastProcessedInputSeq: number;
  entities: EntityState[];
};

export const USER_CMD_SIZE = 13;
export const USER_CMD_PACKET_SIZE = 17;
export const SNAPSHOT_POS_SCALE = 100;
export const SNAPSHOT_VEL_SCALE = 100;

type UserCmdBuffer = ArrayBuffer | ArrayBufferView;
type SnapshotBuffer = ArrayBuffer | ArrayBufferView;

export enum NetPacketType {
  SnapshotFull = 1,
  SnapshotDelta = 2,
}

export type SnapshotDelta = {
  timestamp: number;
  sequence: number;
  lastProcessedInputSeq: number;
  baseSequence: number;
  entities: EntityState[];
  removedIds: number[];
};

// Layout: [Keys(1)] [ViewX(4)] [ViewY(4)] [ViewZ(4)]. Total 13 bytes.
export function encodeUserCmd(cmd: UserCmd): ArrayBuffer {
  const buffer = new ArrayBuffer(USER_CMD_SIZE);
  const view = new DataView(buffer);

  let keys = 0;
  if (cmd.forward) keys |= 1;
  if (cmd.backward) keys |= 2;
  if (cmd.left) keys |= 4;
  if (cmd.right) keys |= 8;
  if (cmd.jump) keys |= 16;
  if (cmd.descend) keys |= 32;

  view.setUint8(0, keys);
  view.setFloat32(1, cmd.viewDir.x, true);
  view.setFloat32(5, cmd.viewDir.y, true);
  view.setFloat32(9, cmd.viewDir.z, true);

  return buffer;
}

export function decodeUserCmd(buffer: UserCmdBuffer): UserCmd {
  const view = buffer instanceof ArrayBuffer
    ? new DataView(buffer)
    : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.byteLength < USER_CMD_SIZE) {
    throw new Error(`UserCmd buffer too small: ${view.byteLength}`);
  }
  const keys = view.getUint8(0);

  return {
    forward: !!(keys & 1),
    backward: !!(keys & 2),
    left: !!(keys & 4),
    right: !!(keys & 8),
    jump: !!(keys & 16),
    descend: !!(keys & 32),
    viewDir: {
      x: view.getFloat32(1, true),
      y: view.getFloat32(5, true),
      z: view.getFloat32(9, true),
    },
  };
}

// UserCmd packet layout:
// [Seq u32(4)] [Keys u8(1)] [ViewDir.x f32] [ViewDir.y f32] [ViewDir.z f32]
export function encodeUserCmdPacket(cmd: UserCmd, sequence: number): ArrayBuffer {
  const buffer = new ArrayBuffer(USER_CMD_PACKET_SIZE);
  const view = new DataView(buffer);
  view.setUint32(0, sequence >>> 0, true);
  const cmdBuffer = encodeUserCmd(cmd);
  new Uint8Array(buffer, 4).set(new Uint8Array(cmdBuffer));
  return buffer;
}

export function decodeUserCmdPacket(buffer: UserCmdBuffer): { sequence: number; cmd: UserCmd } {
  const view = buffer instanceof ArrayBuffer
    ? new DataView(buffer)
    : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.byteLength < USER_CMD_PACKET_SIZE) {
    throw new Error(`UserCmd packet too small: ${view.byteLength}`);
  }
  const sequence = view.getUint32(0, true);
  const cmd = decodeUserCmd(
    buffer instanceof ArrayBuffer
      ? buffer.slice(4)
      : buffer.buffer.slice(buffer.byteOffset + 4, buffer.byteOffset + USER_CMD_PACKET_SIZE),
  );
  return { sequence, cmd };
}

// Snapshot (full) layout:
// [Type u8(1)] [Timestamp f64(8)] [Sequence u32(4)] [LastInputSeq u32(4)] [Count u16(2)] [Entities...]
// Entity layout (fixed size, 44 bytes):
// [Id u32(4)] [Pos 3*i32(12)] [Vel 3*i32(12)] [Rot 4*f32(16)]
export function encodeWorldSnapshot(snapshot: WorldSnapshot): ArrayBuffer {
  const count = snapshot.entities.length;
  const size = 1 + 8 + 4 + 4 + 2 + count * 44;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, NetPacketType.SnapshotFull);
  offset += 1;
  view.setFloat64(offset, snapshot.timestamp, true);
  offset += 8;
  view.setUint32(offset, snapshot.sequence >>> 0, true);
  offset += 4;
  view.setUint32(offset, snapshot.lastProcessedInputSeq >>> 0, true);
  offset += 4;
  view.setUint16(offset, count, true);
  offset += 2;

  for (let i = 0; i < count; i++) {
    const entity = snapshot.entities[i];

    view.setUint32(offset, entity.id >>> 0, true);
    offset += 4;

    view.setInt32(offset, Math.round(entity.position.x * SNAPSHOT_POS_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.position.y * SNAPSHOT_POS_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.position.z * SNAPSHOT_POS_SCALE), true); offset += 4;

    view.setInt32(offset, Math.round(entity.velocity.x * SNAPSHOT_VEL_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.velocity.y * SNAPSHOT_VEL_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.velocity.z * SNAPSHOT_VEL_SCALE), true); offset += 4;

    view.setFloat32(offset, entity.rotation.x, true); offset += 4;
    view.setFloat32(offset, entity.rotation.y, true); offset += 4;
    view.setFloat32(offset, entity.rotation.z, true); offset += 4;
    view.setFloat32(offset, entity.rotation.w, true); offset += 4;
  }

  return buffer;
}

// Snapshot (delta) layout:
// [Type u8(1)] [Timestamp f64(8)] [Sequence u32(4)] [LastInputSeq u32(4)] [BaseSequence u32(4)] [Count u16(2)] [RemovedCount u16(2)]
// [Entities...] [RemovedIds u32...]
export function encodeWorldDelta(delta: SnapshotDelta): ArrayBuffer {
  const count = delta.entities.length;
  const removedCount = delta.removedIds.length;
  const size = 1 + 8 + 4 + 4 + 4 + 2 + 2 + count * 44 + removedCount * 4;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;

  view.setUint8(offset, NetPacketType.SnapshotDelta);
  offset += 1;
  view.setFloat64(offset, delta.timestamp, true);
  offset += 8;
  view.setUint32(offset, delta.sequence >>> 0, true);
  offset += 4;
  view.setUint32(offset, delta.lastProcessedInputSeq >>> 0, true);
  offset += 4;
  view.setUint32(offset, delta.baseSequence >>> 0, true);
  offset += 4;
  view.setUint16(offset, count, true);
  offset += 2;
  view.setUint16(offset, removedCount, true);
  offset += 2;

  for (let i = 0; i < count; i++) {
    const entity = delta.entities[i];

    view.setUint32(offset, entity.id >>> 0, true);
    offset += 4;

    view.setInt32(offset, Math.round(entity.position.x * SNAPSHOT_POS_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.position.y * SNAPSHOT_POS_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.position.z * SNAPSHOT_POS_SCALE), true); offset += 4;

    view.setInt32(offset, Math.round(entity.velocity.x * SNAPSHOT_VEL_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.velocity.y * SNAPSHOT_VEL_SCALE), true); offset += 4;
    view.setInt32(offset, Math.round(entity.velocity.z * SNAPSHOT_VEL_SCALE), true); offset += 4;

    view.setFloat32(offset, entity.rotation.x, true); offset += 4;
    view.setFloat32(offset, entity.rotation.y, true); offset += 4;
    view.setFloat32(offset, entity.rotation.z, true); offset += 4;
    view.setFloat32(offset, entity.rotation.w, true); offset += 4;
  }

  for (let i = 0; i < removedCount; i++) {
    view.setUint32(offset, delta.removedIds[i] >>> 0, true);
    offset += 4;
  }

  return buffer;
}

type SnapshotDecodeResult =
  | { type: NetPacketType.SnapshotFull; snapshot: WorldSnapshot }
  | { type: NetPacketType.SnapshotDelta; delta: SnapshotDelta };

export function decodeNetMessage(buffer: SnapshotBuffer): SnapshotDecodeResult {
  const view = buffer instanceof ArrayBuffer
    ? new DataView(buffer)
    : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (view.byteLength < 1) {
    throw new Error(`Net message buffer too small: ${view.byteLength}`);
  }

  let offset = 0;
  const type = view.getUint8(offset);
  offset += 1;

  if (type === NetPacketType.SnapshotFull) {
    if (view.byteLength < 1 + 8 + 4 + 4 + 2) {
      throw new Error(`Snapshot buffer too small: ${view.byteLength}`);
    }
    const timestamp = view.getFloat64(offset, true);
    offset += 8;
    const sequence = view.getUint32(offset, true);
    offset += 4;
    const lastProcessedInputSeq = view.getUint32(offset, true);
    offset += 4;
    const count = view.getUint16(offset, true);
    offset += 2;

    const entities: EntityState[] = [];

    for (let i = 0; i < count; i++) {
      if (offset >= view.byteLength) {
        throw new Error('Snapshot buffer truncated');
      }
      const id = view.getUint32(offset, true);
      offset += 4;

      const pos = {
        x: view.getInt32(offset, true) / SNAPSHOT_POS_SCALE,
        y: view.getInt32(offset + 4, true) / SNAPSHOT_POS_SCALE,
        z: view.getInt32(offset + 8, true) / SNAPSHOT_POS_SCALE,
      };
      offset += 12;
      const vel = {
        x: view.getInt32(offset, true) / SNAPSHOT_VEL_SCALE,
        y: view.getInt32(offset + 4, true) / SNAPSHOT_VEL_SCALE,
        z: view.getInt32(offset + 8, true) / SNAPSHOT_VEL_SCALE,
      };
      offset += 12;
      const rot = {
        x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true),
        z: view.getFloat32(offset + 8, true), w: view.getFloat32(offset + 12, true),
      };
      offset += 16;

      entities.push({
        id,
        position: pos,
        velocity: vel,
        rotation: rot,
      });
    }

    return {
      type: NetPacketType.SnapshotFull,
      snapshot: { timestamp, sequence, lastProcessedInputSeq, entities },
    };
  }

  if (type === NetPacketType.SnapshotDelta) {
    if (view.byteLength < 1 + 8 + 4 + 4 + 4 + 2 + 2) {
      throw new Error(`Delta buffer too small: ${view.byteLength}`);
    }
    const timestamp = view.getFloat64(offset, true);
    offset += 8;
    const sequence = view.getUint32(offset, true);
    offset += 4;
    const lastProcessedInputSeq = view.getUint32(offset, true);
    offset += 4;
    const baseSequence = view.getUint32(offset, true);
    offset += 4;
    const count = view.getUint16(offset, true);
    offset += 2;
    const removedCount = view.getUint16(offset, true);
    offset += 2;

    const entities: EntityState[] = [];
    for (let i = 0; i < count; i++) {
      if (offset >= view.byteLength) {
        throw new Error('Delta buffer truncated');
      }
      const id = view.getUint32(offset, true);
      offset += 4;

      const pos = {
        x: view.getInt32(offset, true) / SNAPSHOT_POS_SCALE,
        y: view.getInt32(offset + 4, true) / SNAPSHOT_POS_SCALE,
        z: view.getInt32(offset + 8, true) / SNAPSHOT_POS_SCALE,
      };
      offset += 12;
      const vel = {
        x: view.getInt32(offset, true) / SNAPSHOT_VEL_SCALE,
        y: view.getInt32(offset + 4, true) / SNAPSHOT_VEL_SCALE,
        z: view.getInt32(offset + 8, true) / SNAPSHOT_VEL_SCALE,
      };
      offset += 12;
      const rot = {
        x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true),
        z: view.getFloat32(offset + 8, true), w: view.getFloat32(offset + 12, true),
      };
      offset += 16;

      entities.push({
        id,
        position: pos,
        velocity: vel,
        rotation: rot,
      });
    }

    const removedIds: number[] = [];
    for (let i = 0; i < removedCount; i++) {
      if (offset + 4 > view.byteLength) {
        throw new Error('Delta buffer truncated at removed list');
      }
      removedIds.push(view.getUint32(offset, true));
      offset += 4;
    }

    return {
      type: NetPacketType.SnapshotDelta,
      delta: { timestamp, sequence, lastProcessedInputSeq, baseSequence, entities, removedIds },
    };
  }

  throw new Error(`Unknown net packet type: ${type}`);
}
