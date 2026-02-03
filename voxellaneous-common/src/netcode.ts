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
  entities: EntityState[];
};

export const USER_CMD_SIZE = 13;
export const SNAPSHOT_POS_SCALE = 100;
export const SNAPSHOT_VEL_SCALE = 100;

type UserCmdBuffer = ArrayBuffer | ArrayBufferView;
type SnapshotBuffer = ArrayBuffer | ArrayBufferView;

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

// Snapshot layout:
// [Timestamp f64(8)] [Count u16(2)] [Entities...]
// Entity layout (fixed size, 44 bytes):
// [Id u32(4)] [Pos 3*i32(12)] [Vel 3*i32(12)] [Rot 4*f32(16)]
export function encodeWorldSnapshot(snapshot: WorldSnapshot): ArrayBuffer {
  const count = snapshot.entities.length;
  const size = 8 + 2 + count * 44;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let offset = 0;

  view.setFloat64(offset, snapshot.timestamp, true);
  offset += 8;
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

export function decodeWorldSnapshot(buffer: SnapshotBuffer): WorldSnapshot {
  const view = buffer instanceof ArrayBuffer
    ? new DataView(buffer)
    : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (view.byteLength < 10) {
    throw new Error(`Snapshot buffer too small: ${view.byteLength}`);
  }

  let offset = 0;
  const timestamp = view.getFloat64(offset, true);
  offset += 8;
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

  return { timestamp, entities };
}
