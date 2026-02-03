import http from 'http';
import geckos, { GeckosServer, ServerChannel } from '@geckos.io/server';
import {
  EntityState,
  UserCmd,
  WorldSnapshot,
  decodeUserCmd,
  decodeUserCmdPacket,
  encodeWorldSnapshot,
  encodeWorldDelta,
  SnapshotDelta,
} from './types';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const PLAYER_TIMEOUT_MS = Number.parseInt(process.env.PLAYER_TIMEOUT_MS || '300000', 10); // 5 minutes default
const INTEREST_RADIUS = Number.parseInt(process.env.INTEREST_RADIUS || '1000', 10);
const CMD_RATE_LIMIT_HZ = Number.parseInt(process.env.CMD_RATE_LIMIT_HZ || '120', 10);

type PlayerEntity = EntityState & {
  channel: ServerChannel;
  input: UserCmd;
  lastInputTime: number;
  lastProcessedInputSeq: number;
  lastCmdTime: number;
  cmdBurst: number;
};

class GameServer {
  private io: GeckosServer;
  private players: Map<number, PlayerEntity> = new Map();
  private lastTimestamp: number = Date.now();
  private nextPlayerId = 1;

  constructor() {
    this.io = geckos({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });

    this.io.addServer(http.createServer().listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    }));

    this.io.onConnection((channel: ServerChannel) => {
      console.log(`Player connected: ${channel.id}`);
      this.handleConnection(channel);
    });
  }

  private handleConnection(channel: ServerChannel) {
    const playerId = this.nextPlayerId >>> 0;
    this.nextPlayerId = (this.nextPlayerId + 1) >>> 0;

    // Initial state
    const player: PlayerEntity = {
      id: playerId,
      position: { x: -100, y: -470, z: -356 }, // Match client spawn
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      channel: channel,
      input: {
        forward: false,
        backward: false,
        left: false,
        right: false,
        jump: false,
        descend: false,
        viewDir: { x: 0, y: 0, z: 1 },
      },
      lastInputTime: Date.now(),
      lastProcessedInputSeq: 0,
      lastCmdTime: 0,
      cmdBurst: 0,
    };

    this.players.set(playerId, player);

    // Notify player of their ID
    channel.emit('welcome', { id: playerId }, { reliable: true });

    channel.onDisconnect(() => {
      console.log(`Player disconnected: ${playerId}`);
      this.players.delete(playerId);
      this.lastSnapshotStateByPlayer.delete(playerId);
      this.lastSnapshotSeqByPlayer.delete(playerId);
      this.forceFullForPlayer.delete(playerId);
    });

    channel.on('ping', (data: any) => {
      const clientTime = typeof data?.clientTime === 'number' ? data.clientTime : Date.now();
      channel.emit('pong', { clientTime, serverTime: Date.now() });
    });

    channel.on('resync', () => {
      this.forceFullForPlayer.add(playerId);
      this.lastSnapshotStateByPlayer.delete(playerId);
      this.lastSnapshotSeqByPlayer.delete(playerId);
    });

    const handleUserCmd = (data: any) => {
      if (!this.allowUserCmd(player)) {
        return;
      }
      let cmd: UserCmd | null = null;
      try {
        const binary = this.normalizeUserCmdPayload(data);
        if (binary) {
          const decoded = decodeUserCmdPacket(binary);
          cmd = this.sanitizeUserCmd(decoded.cmd);
          player.lastProcessedInputSeq = decoded.sequence;
        } else if (data && typeof data === 'object' && 'viewDir' in data) {
          // Legacy JSON fallback (should not happen in normal binary flow)
          cmd = this.sanitizeUserCmd(data as UserCmd);
        }
      } catch (e) {
        console.error('Failed to decode userCmd:', e);
      }

      if (!cmd) return;
      player.input = cmd;
      player.lastInputTime = Date.now();
    };

    if (typeof channel.onRaw === 'function') {
      channel.onRaw(handleUserCmd);
    }
    channel.on('userCmd', handleUserCmd);
  }

  private normalizeUserCmdPayload(data: any): ArrayBuffer | ArrayBufferView | null {
    if (!data) return null;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return data;
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
      return new Uint8Array(data.data);
    }
    if (data && typeof data === 'object' && typeof data.length === 'number') {
      const len = data.length >>> 0;
      if (len > 0) {
        const arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          const v = data[i];
          arr[i] = typeof v === 'number' ? v : 0;
        }
        return arr;
      }
    }
    return null;
  }

  private sanitizeUserCmd(cmd: UserCmd): UserCmd {
    const safeBool = (v: any) => !!v;
    const safeNum = (v: any) => (Number.isFinite(v) ? v : 0);

    let x = safeNum(cmd.viewDir?.x);
    let y = safeNum(cmd.viewDir?.y);
    let z = safeNum(cmd.viewDir?.z);

    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      x /= len;
      y /= len;
      z /= len;
    } else {
      x = 0;
      y = 0;
      z = 1;
    }

    return {
      forward: safeBool(cmd.forward),
      backward: safeBool(cmd.backward),
      left: safeBool(cmd.left),
      right: safeBool(cmd.right),
      jump: safeBool(cmd.jump),
      descend: safeBool(cmd.descend),
      viewDir: { x, y, z },
    };
  }

  private allowUserCmd(player: PlayerEntity): boolean {
    const now = Date.now();
    const minIntervalMs = 1000 / CMD_RATE_LIMIT_HZ;

    if (player.lastCmdTime === 0) {
      player.lastCmdTime = now;
      player.cmdBurst = 0;
      return true;
    }

    const dt = now - player.lastCmdTime;
    if (dt >= minIntervalMs) {
      player.lastCmdTime = now;
      player.cmdBurst = 0;
      return true;
    }

    player.cmdBurst += 1;
    if (player.cmdBurst > 5) {
      // Drop extra spammy packets.
      this.metrics.cmdDropped += 1;
      return false;
    }

    return true;
  }

  private lastNetworkBroadcast: number = 0;
  private accumulator: number = 0;
  private snapshotSequence: number = 0;
  private lastSnapshotStateByPlayer: Map<number, Map<number, EntityState>> = new Map();
  private lastSnapshotSeqByPlayer: Map<number, number> = new Map();
  private readonly fullSnapshotInterval = 10;
  private forceFullForPlayer: Set<number> = new Set();
  private metrics = {
    snapshotsSent: 0,
    deltasSent: 0,
    bytesSent: 0,
    snapshotBytes: 0,
    deltaBytes: 0,
    cmdDropped: 0,
    lastLogAt: Date.now(),
  };

  public start() {
    // Run the loop at roughly 60Hz to ensure we process physics often enough
    const TICK_RATE_MS = 1000 / 60;
    setInterval(() => this.tick(), TICK_RATE_MS);
  }

  private tick() {
    const now = Date.now();
    // Frame time limit to prevent "Spiral of Death" if server lags heavily
    let frameTime = now - this.lastTimestamp;
    if (frameTime > 250) frameTime = 250;

    this.lastTimestamp = now;
    this.accumulator += frameTime;

    const PHYSICS_RATE = 60;
    const PHYSICS_DT_SEC = 1.0 / PHYSICS_RATE;
    const PHYSICS_DT_MS = 1000 / PHYSICS_RATE;

    // Fixed Update Step
    while (this.accumulator >= PHYSICS_DT_MS) {
      this.fixedUpdate(PHYSICS_DT_SEC);
      this.accumulator -= PHYSICS_DT_MS;
    }

    // Network Broadcast Step
    // Tuning: 60Hz for maximum smoothness/responsiveness (High Bandwidth!)
    const NETWORK_RATE = 60;
    const NETWORK_INTERVAL_MS = 1000 / NETWORK_RATE;

    if (now - this.lastNetworkBroadcast >= NETWORK_INTERVAL_MS) {
      this.broadcastSnapshot(now);
      this.lastNetworkBroadcast = now;
    }

    // Check for timeouts
    this.players.forEach((player) => {
      if (now - player.lastInputTime > PLAYER_TIMEOUT_MS) {
        console.log(`Player ${player.id} timed out (AFK)`);
        player.channel.close();
        this.players.delete(player.id);
      }
    });
  }

  private fixedUpdate(dt: number) {
    // 1. Simulate Physics
    this.players.forEach((player) => {
      this.simulatePlayer(player, dt);
    });
  }

  private broadcastSnapshot(timestamp: number) {
    const sequence = this.snapshotSequence >>> 0;
    const allEntities = Array.from(this.players.values()).map(p => ({
      id: p.id,
      position: p.position,
      velocity: p.velocity,
      rotation: p.rotation,
    }));

    for (const player of this.players.values()) {
      const entities = this.filterEntitiesForPlayer(player, allEntities);
      const lastState = this.lastSnapshotStateByPlayer.get(player.id) ?? new Map();
      const lastSeq = this.lastSnapshotSeqByPlayer.get(player.id) ?? 0;
      const sendFull = this.forceFullForPlayer.has(player.id) || lastState.size === 0 || (sequence % this.fullSnapshotInterval === 0);

      if (sendFull || !player.channel.raw) {
        const snapshot: WorldSnapshot = {
          timestamp,
          sequence,
          lastProcessedInputSeq: player.lastProcessedInputSeq,
          entities,
        };
        const payload = encodeWorldSnapshot(snapshot);
        this.sendSnapshotPayloadToChannel(player.channel, payload, snapshot);
        this.metrics.snapshotsSent += 1;
        this.metrics.bytesSent += payload.byteLength;
        this.metrics.snapshotBytes += payload.byteLength;
        this.lastSnapshotStateByPlayer.set(player.id, this.cloneStateMap(snapshot.entities));
        this.lastSnapshotSeqByPlayer.set(player.id, sequence);
        this.forceFullForPlayer.delete(player.id);
      } else {
        const delta = this.buildDeltaSnapshot(
          timestamp,
          sequence,
          player.lastProcessedInputSeq,
          lastSeq,
          entities,
          lastState,
        );
        const payload = encodeWorldDelta(delta);
        this.sendSnapshotPayloadToChannel(player.channel, payload);
        this.metrics.deltasSent += 1;
        this.metrics.bytesSent += payload.byteLength;
        this.metrics.deltaBytes += payload.byteLength;
        this.lastSnapshotStateByPlayer.set(player.id, this.cloneStateMap(entities));
        this.lastSnapshotSeqByPlayer.set(player.id, sequence);
      }
    }

    this.snapshotSequence = (this.snapshotSequence + 1) >>> 0;
    this.logMetrics();
  }

  private logMetrics() {
    const now = Date.now();
    if (now - this.metrics.lastLogAt < 5000) return;
    const seconds = (now - this.metrics.lastLogAt) / 1000;
    const snapshotRate = this.metrics.snapshotsSent / seconds;
    const deltaRate = this.metrics.deltasSent / seconds;
    const kbps = this.metrics.bytesSent / seconds / 1024;
    const avgSnapshotBytes = this.metrics.snapshotsSent > 0
      ? this.metrics.snapshotBytes / this.metrics.snapshotsSent
      : 0;
    const avgDeltaBytes = this.metrics.deltasSent > 0
      ? this.metrics.deltaBytes / this.metrics.deltasSent
      : 0;
    const payload = {
      type: 'net',
      snapshotsPerSec: Number(snapshotRate.toFixed(1)),
      deltasPerSec: Number(deltaRate.toFixed(1)),
      kbps: Number(kbps.toFixed(1)),
      avgSnapshotBytes: Number(avgSnapshotBytes.toFixed(1)),
      avgDeltaBytes: Number(avgDeltaBytes.toFixed(1)),
      cmdDropped: this.metrics.cmdDropped,
      players: this.players.size,
    };
    console.log(JSON.stringify(payload));
    this.metrics.snapshotsSent = 0;
    this.metrics.deltasSent = 0;
    this.metrics.bytesSent = 0;
    this.metrics.snapshotBytes = 0;
    this.metrics.deltaBytes = 0;
    this.metrics.cmdDropped = 0;
    this.metrics.lastLogAt = now;
  }

  private buildDeltaSnapshot(
    timestamp: number,
    sequence: number,
    lastProcessedInputSeq: number,
    baseSequence: number,
    entities: EntityState[],
    lastState: Map<number, EntityState>,
  ): SnapshotDelta {
    const changed: EntityState[] = [];
    const currentIds = new Set<number>();

    for (const entity of entities) {
      currentIds.add(entity.id);
      const prev = lastState.get(entity.id);
      if (!prev || !this.isEntityEqual(prev, entity)) {
        changed.push(entity);
      }
    }

    const removedIds: number[] = [];
    for (const prevId of lastState.keys()) {
      if (!currentIds.has(prevId)) {
        removedIds.push(prevId);
      }
    }

    return {
      timestamp,
      sequence,
      lastProcessedInputSeq,
      baseSequence,
      entities: changed,
      removedIds,
    };
  }

  private isEntityEqual(a: EntityState, b: EntityState): boolean {
    return (
      a.position.x === b.position.x &&
      a.position.y === b.position.y &&
      a.position.z === b.position.z &&
      a.velocity.x === b.velocity.x &&
      a.velocity.y === b.velocity.y &&
      a.velocity.z === b.velocity.z &&
      a.rotation.x === b.rotation.x &&
      a.rotation.y === b.rotation.y &&
      a.rotation.z === b.rotation.z &&
      a.rotation.w === b.rotation.w
    );
  }

  private sendSnapshotPayloadToChannel(channel: ServerChannel, payload: ArrayBuffer, snapshot?: WorldSnapshot) {
    if (channel.raw && typeof channel.raw.emit === 'function') {
      channel.raw.emit(payload);
    } else if (snapshot) {
      channel.emit('snapshot', snapshot);
    }
  }

  private cloneStateMap(entities: EntityState[]): Map<number, EntityState> {
    return new Map(
      entities.map(e => [e.id, { ...e, position: { ...e.position }, velocity: { ...e.velocity }, rotation: { ...e.rotation } }]),
    );
  }

  private filterEntitiesForPlayer(player: PlayerEntity, entities: EntityState[]): EntityState[] {
    const radiusSq = INTEREST_RADIUS * INTEREST_RADIUS;
    return entities.filter((entity) => {
      if (entity.id === player.id) return true;
      const dx = entity.position.x - player.position.x;
      const dy = entity.position.y - player.position.y;
      const dz = entity.position.z - player.position.z;
      return dx * dx + dy * dy + dz * dz <= radiusSq;
    });
  }

  private simulatePlayer(player: PlayerEntity, dt: number) {
    const speed = 60; // Match client speed
    const { input } = player;

    // We must match camera.ts logic EXACTLY
    // 1. Accumulate motion vector
    let mx = 0;
    let my = 0;
    let mz = 0;

    const dirX = input.viewDir?.x || 0;
    const dirY = input.viewDir?.y || 0; // Unused for horizontal motion
    const dirZ = input.viewDir?.z || 0;

    // Camera Direction - Projected on XZ plane implies ignoring Y
    // Camera.ts: [x, _, z] = direction.
    // So we use viewDir as is but only utilize x and z components for Forward/Back.
    const forwardX = dirX;
    const forwardZ = dirZ;

    // Client Right vector logic:
    // vec3.cross(right, dir, up). If up is (0,1,0):
    // right = (-dirZ, 0, dirX). normalized.
    // Let's rely on standard math:
    const rightX = -dirZ;
    const rightZ = dirX;

    // Note: Since we will normalize the final SUM, we don't strictly need to normalize 'right' yet 
    // IF the client accumulates un-normalized vectors.

    if (input.forward) {
      mx += forwardX;
      mz += forwardZ;
    }
    if (input.backward) {
      mx -= forwardX;
      mz -= forwardZ;
    }
    if (input.right) {
      const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
      const nrX = len > 0 ? rightX / len : 0;
      const nrZ = len > 0 ? rightZ / len : 0;

      mx += nrX;
      mz += nrZ;
    }
    if (input.left) {
      const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
      const nrX = len > 0 ? rightX / len : 0;
      const nrZ = len > 0 ? rightZ / len : 0;

      mx -= nrX;
      mz -= nrZ;
    }

    if (input.jump) {
      my += 1;
    }
    if (input.descend) {
      my -= 1;
    }

    // 2. Normalize entire motion vector
    // This is the key: (Forward + Right) length > 1, so we must normalize.
    const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
    if (mLen > 0) {
      mx /= mLen;
      my /= mLen;
      mz /= mLen;

      // 3. Scale by Speed * dt
      const moveStep = speed * dt;
      mx *= moveStep;
      my *= moveStep;
      mz *= moveStep;

      player.position.x += mx;
      player.position.y += my;
      player.position.z += mz;

      player.velocity.x = mx / dt;
      player.velocity.y = my / dt;
      player.velocity.z = mz / dt;
    } else {
      player.velocity.x = 0;
      player.velocity.y = 0;
      player.velocity.z = 0;
    }
  }
}

const game = new GameServer();
game.start();
console.log('Game Server started');
