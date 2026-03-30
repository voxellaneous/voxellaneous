import http from 'http';
import geckos, { GeckosServer, ServerChannel } from '@geckos.io/server';
import {
  EntityState,
  WorldSnapshot,
  encodeWorldSnapshot,
  encodeWorldDelta,
  SnapshotDelta,
} from '../voxellaneous-common/src/netcode';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const PLAYER_TIMEOUT_MS = Number.parseInt(process.env.PLAYER_TIMEOUT_MS || '300000', 10);
const INTEREST_RADIUS = Number.parseInt(process.env.INTEREST_RADIUS || '1000', 10);

type PlayerEntity = {
  id: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  channel: ServerChannel;
  lastInputTime: number;
};

class GameServer {
  private io: GeckosServer;
  private players: Map<number, PlayerEntity> = new Map();
  private nextPlayerId = 1;
  private lastNetworkBroadcast: number = 0;
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
    lastLogAt: Date.now(),
  };

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

    const player: PlayerEntity = {
      id: playerId,
      position: { x: 3770, y: 300, z: 620 },
      velocity: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      channel,
      lastInputTime: Date.now(),
    };

    this.players.set(playerId, player);
    channel.emit('welcome', { id: playerId, spawn: player.position }, { reliable: true });

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

    channel.on('position', (data: any) => {
      if (!data || typeof data.x !== 'number' || typeof data.y !== 'number' || typeof data.z !== 'number') return;
      const x = Number.isFinite(data.x) ? data.x : 0;
      const y = Number.isFinite(data.y) ? data.y : 0;
      const z = Number.isFinite(data.z) ? data.z : 0;

      player.position.x = x;
      player.position.y = y;
      player.position.z = z;
      player.lastInputTime = Date.now();
    });
  }

  public start() {
    setInterval(() => this.tick(), 1000 / 60);
  }

  private tick() {
    const now = Date.now();
    const NETWORK_INTERVAL_MS = 1000 / 60;

    if (now - this.lastNetworkBroadcast >= NETWORK_INTERVAL_MS) {
      this.broadcastSnapshot(now);
      this.lastNetworkBroadcast = now;
    }

    this.players.forEach((player) => {
      if (now - player.lastInputTime > PLAYER_TIMEOUT_MS) {
        console.log(`Player ${player.id} timed out (AFK)`);
        player.channel.close();
        this.players.delete(player.id);
      }
    });
  }

  private broadcastSnapshot(timestamp: number) {
    const sequence = this.snapshotSequence >>> 0;
    const allEntities: EntityState[] = Array.from(this.players.values()).map(p => ({
      id: p.id,
      position: p.position,
      velocity: p.velocity,
      rotation: p.rotation,
    }));

    for (const player of this.players.values()) {
      const entities = this.filterEntitiesForPlayer(player, allEntities);
      const lastState = this.lastSnapshotStateByPlayer.get(player.id) ?? new Map();
      const sendFull = this.forceFullForPlayer.has(player.id) || lastState.size === 0 || (sequence % this.fullSnapshotInterval === 0);

      if (sendFull || !player.channel.raw) {
        const snapshot: WorldSnapshot = {
          timestamp,
          sequence,
          lastProcessedInputSeq: 0,
          entities,
        };
        const payload = encodeWorldSnapshot(snapshot);
        this.sendSnapshotPayloadToChannel(player.channel, payload, snapshot);
        this.metrics.snapshotsSent += 1;
        this.metrics.bytesSent += payload.byteLength;
        this.metrics.snapshotBytes += payload.byteLength;
        this.lastSnapshotStateByPlayer.set(player.id, this.cloneStateMap(entities));
        this.lastSnapshotSeqByPlayer.set(player.id, sequence);
        this.forceFullForPlayer.delete(player.id);
      } else {
        const lastSeq = this.lastSnapshotSeqByPlayer.get(player.id) ?? 0;
        const delta = this.buildDeltaSnapshot(timestamp, sequence, 0, lastSeq, entities, lastState);
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
    const payload = {
      type: 'net',
      snapshotsPerSec: Number((this.metrics.snapshotsSent / seconds).toFixed(1)),
      deltasPerSec: Number((this.metrics.deltasSent / seconds).toFixed(1)),
      kbps: Number((this.metrics.bytesSent / seconds / 1024).toFixed(1)),
      avgSnapshotBytes: this.metrics.snapshotsSent > 0 ? Number((this.metrics.snapshotBytes / this.metrics.snapshotsSent).toFixed(1)) : 0,
      avgDeltaBytes: this.metrics.deltasSent > 0 ? Number((this.metrics.deltaBytes / this.metrics.deltasSent).toFixed(1)) : 0,
      players: this.players.size,
    };
    console.log(JSON.stringify(payload));
    Object.assign(this.metrics, {
      snapshotsSent: 0, deltasSent: 0, bytesSent: 0,
      snapshotBytes: 0, deltaBytes: 0, lastLogAt: now,
    });
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

    return { timestamp, sequence, lastProcessedInputSeq, baseSequence, entities: changed, removedIds };
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
}

const game = new GameServer();
game.start();
console.log('Game Server started');
