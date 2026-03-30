import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import {
  type Vector3 as PbVector3,
  type Quaternion as PbQuaternion,
  type EntityState as PbEntityState,
  NetMessageSchema,
  WorldSnapshotSchema,
  SnapshotDeltaSchema,
  EntityStateSchema,
  Vector3Schema,
  QuaternionSchema,
} from './gen/netcode_pb';

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

export type SnapshotDelta = {
  timestamp: number;
  sequence: number;
  lastProcessedInputSeq: number;
  baseSequence: number;
  entities: EntityState[];
  removedIds: number[];
};

export enum NetPacketType {
  SnapshotFull = 1,
  SnapshotDelta = 2,
}

type SnapshotDecodeResult =
  | { type: NetPacketType.SnapshotFull; snapshot: WorldSnapshot }
  | { type: NetPacketType.SnapshotDelta; delta: SnapshotDelta };

function vecToProto(v: Vector3): PbVector3 {
  return create(Vector3Schema, { x: v.x, y: v.y, z: v.z });
}

function quatToProto(q: Quaternion): PbQuaternion {
  return create(QuaternionSchema, { x: q.x, y: q.y, z: q.z, w: q.w });
}

function protoToVec(v: PbVector3 | undefined): Vector3 {
  return { x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 };
}

function protoToQuat(q: PbQuaternion | undefined): Quaternion {
  return { x: q?.x ?? 0, y: q?.y ?? 0, z: q?.z ?? 0, w: q?.w ?? 0 };
}

function toBytes(buffer: ArrayBuffer | ArrayBufferView): Uint8Array {
  return buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function entityToProto(e: EntityState): PbEntityState {
  return create(EntityStateSchema, {
    id: e.id,
    position: vecToProto(e.position),
    velocity: vecToProto(e.velocity),
    rotation: quatToProto(e.rotation),
  });
}

function protoToEntity(pb: PbEntityState): EntityState {
  return {
    id: pb.id,
    position: protoToVec(pb.position),
    velocity: protoToVec(pb.velocity),
    rotation: protoToQuat(pb.rotation),
  };
}

export function encodeWorldSnapshot(snapshot: WorldSnapshot): ArrayBuffer {
  const msg = create(NetMessageSchema, {
    payload: {
      case: 'snapshot',
      value: create(WorldSnapshotSchema, {
        timestamp: snapshot.timestamp,
        sequence: snapshot.sequence >>> 0,
        lastProcessedInputSeq: snapshot.lastProcessedInputSeq >>> 0,
        entities: snapshot.entities.map(entityToProto),
      }),
    },
  });
  const bytes = toBinary(NetMessageSchema, msg);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function encodeWorldDelta(delta: SnapshotDelta): ArrayBuffer {
  const msg = create(NetMessageSchema, {
    payload: {
      case: 'delta',
      value: create(SnapshotDeltaSchema, {
        timestamp: delta.timestamp,
        sequence: delta.sequence >>> 0,
        lastProcessedInputSeq: delta.lastProcessedInputSeq >>> 0,
        baseSequence: delta.baseSequence >>> 0,
        entities: delta.entities.map(entityToProto),
        removedIds: delta.removedIds.map(id => id >>> 0),
      }),
    },
  });
  const bytes = toBinary(NetMessageSchema, msg);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function decodeNetMessage(buffer: ArrayBuffer | ArrayBufferView): SnapshotDecodeResult {
  const msg = fromBinary(NetMessageSchema, toBytes(buffer));

  if (msg.payload.case === 'snapshot') {
    const s = msg.payload.value;
    return {
      type: NetPacketType.SnapshotFull,
      snapshot: {
        timestamp: s.timestamp,
        sequence: s.sequence,
        lastProcessedInputSeq: s.lastProcessedInputSeq,
        entities: s.entities.map(protoToEntity),
      },
    };
  }

  if (msg.payload.case === 'delta') {
    const d = msg.payload.value;
    return {
      type: NetPacketType.SnapshotDelta,
      delta: {
        timestamp: d.timestamp,
        sequence: d.sequence,
        lastProcessedInputSeq: d.lastProcessedInputSeq,
        baseSequence: d.baseSequence,
        entities: d.entities.map(protoToEntity),
        removedIds: d.removedIds,
      },
    };
  }

  throw new Error(`Unknown or empty NetMessage payload case: ${msg.payload.case}`);
}
