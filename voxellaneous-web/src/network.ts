import geckos, { ClientChannel } from '@geckos.io/client';
import {
  EntityState,
  WorldSnapshot,
  decodeNetMessage,
  NetPacketType,
} from '../../voxellaneous-common/src/netcode';

type NetworkOptions = {
  url: string;
};

export class NetworkClient {
  private channel: ClientChannel;
  private entities: Map<number | 'ME', EntityState> = new Map();
  private myId: number | null = null;
  private snapshots: (WorldSnapshot & { receivedAt: number })[] = [];
  private lastSnapshotSeq: number | null = null;
  private isConnected = false;
  private lastRttMs = 0;
  private pingIntervalId: number | null = null;
  private snapshotState: Map<number, EntityState> = new Map();
  private lastAppliedSequence: number | null = null;
  private lastResyncAt = 0;
  private spawnPosition: { x: number; y: number; z: number } | null = null;
  private onSpawnCallback: ((pos: { x: number; y: number; z: number }) => void) | null = null;

  constructor(_options: NetworkOptions) {
    const port = 8080;
    const url = `${window.location.protocol}//${window.location.hostname}`;

    console.log(`Connecting to Geckos: url=${url}, port=${port}`);
    this.channel = geckos({ url, port });

    this.channel.onConnect((error) => {
      if (error) {
        console.error('Network connection error:', error.message);
        return;
      }

      console.log('Connected to server!');
      this.isConnected = true;

      this.channel.on('welcome', (data: any) => {
        this.myId = typeof data?.id === 'number' ? data.id : Number(data?.id);
        console.log('My Player ID:', this.myId);
        if (data?.spawn && typeof data.spawn.x === 'number') {
          this.spawnPosition = data.spawn;
          this.onSpawnCallback?.(data.spawn);
        }
      });

      this.channel.on('snapshot', (data: any) => {
        this.handleSnapshot(data as WorldSnapshot);
      });

      this.channel.on('pong', (data: any) => {
        if (!data || typeof data.clientTime !== 'number') return;
        this.lastRttMs = Date.now() - data.clientTime;
      });

      if (this.pingIntervalId === null) {
        this.pingIntervalId = window.setInterval(() => {
          this.channel.emit('ping', { clientTime: Date.now() });
        }, 1000);
      }

      const rawChannel = this.channel as any;
      if (typeof rawChannel.onRaw === 'function') {
        rawChannel.onRaw((data: any) => {
          try {
            const message = decodeNetMessage(data);
            if (message.type === NetPacketType.SnapshotFull) {
              this.handleSnapshot(message.snapshot);
            } else if (message.type === NetPacketType.SnapshotDelta) {
              this.handleDelta(message.delta);
            }
          } catch (e) {
            console.error('Failed to decode binary snapshot:', e);
          }
        });
      }
    });
  }

  public sendPosition(x: number, y: number, z: number, yaw: number) {
    if (!this.isConnected) return;
    this.channel.emit('position', { x, y, z, yaw }, { reliable: false });
  }

  private applySnapshot(snapshot: WorldSnapshot) {
    this.lastSnapshotSeq = snapshot.sequence;
    this.lastAppliedSequence = snapshot.sequence;

    this.snapshots.push({ ...snapshot, receivedAt: Date.now() });
    if (this.snapshots.length > 30) {
      this.snapshots.shift();
    }

    this.entities.clear();
    for (const entity of snapshot.entities) {
      this.entities.set(entity.id === this.myId ? 'ME' : entity.id, entity);
    }
  }

  private handleSnapshot(snapshot: WorldSnapshot) {
    if (this.lastSnapshotSeq !== null && snapshot.sequence <= this.lastSnapshotSeq) {
      return;
    }
    this.snapshotState.clear();
    for (const entity of snapshot.entities) {
      this.snapshotState.set(entity.id, entity);
    }
    this.applySnapshot(snapshot);
  }

  private handleDelta(delta: {
    timestamp: number;
    sequence: number;
    lastProcessedInputSeq: number;
    baseSequence: number;
    entities: EntityState[];
    removedIds: number[];
  }) {
    if (this.lastAppliedSequence === null || delta.baseSequence !== this.lastAppliedSequence) {
      this.requestResync();
      return;
    }

    for (const entity of delta.entities) {
      this.snapshotState.set(entity.id, entity);
    }
    for (const id of delta.removedIds) {
      this.snapshotState.delete(id);
    }

    this.applySnapshot({
      timestamp: delta.timestamp,
      sequence: delta.sequence,
      lastProcessedInputSeq: delta.lastProcessedInputSeq,
      entities: Array.from(this.snapshotState.values()),
    });
  }

  public getRemoteEntities(): EntityState[] {
    const INTERPOLATION_DELAY_MS = 45;
    if (this.snapshots.length < 2) return [];

    const renderTime = Date.now() - INTERPOLATION_DELAY_MS;

    let t1 = this.snapshots[0];
    let t2 = this.snapshots[1];
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].receivedAt <= renderTime && this.snapshots[i + 1].receivedAt >= renderTime) {
        t1 = this.snapshots[i];
        t2 = this.snapshots[i + 1];
        break;
      }
    }

    if (renderTime > t2.receivedAt) t1 = t2;

    const total = t2.receivedAt - t1.receivedAt;
    const alpha = Math.max(0, Math.min(1, total > 0 ? (renderTime - t1.receivedAt) / total : 0));

    const interpolated: EntityState[] = [];
    for (const ent2 of t2.entities) {
      if (ent2.id === this.myId) continue;
      const ent1 = t1.entities.find(e => e.id === ent2.id);
      if (ent1) {
        interpolated.push({
          id: ent2.id,
          position: {
            x: ent1.position.x + (ent2.position.x - ent1.position.x) * alpha,
            y: ent1.position.y + (ent2.position.y - ent1.position.y) * alpha,
            z: ent1.position.z + (ent2.position.z - ent1.position.z) * alpha,
          },
          velocity: ent2.velocity,
          rotation: {
            x: ent1.rotation.x + (ent2.rotation.x - ent1.rotation.x) * alpha,
            y: ent1.rotation.y + (ent2.rotation.y - ent1.rotation.y) * alpha,
            z: ent1.rotation.z + (ent2.rotation.z - ent1.rotation.z) * alpha,
            w: ent1.rotation.w + (ent2.rotation.w - ent1.rotation.w) * alpha,
          },
        });
      } else {
        interpolated.push(ent2);
      }
    }
    return interpolated;
  }

  public getPingMs(): number {
    return this.lastRttMs;
  }

  public onSpawn(cb: (pos: { x: number; y: number; z: number }) => void): void {
    if (this.spawnPosition) { cb(this.spawnPosition); return; }
    this.onSpawnCallback = cb;
  }

  private requestResync() {
    const now = Date.now();
    if (now - this.lastResyncAt < 1000) return;
    this.lastResyncAt = now;
    this.snapshots.length = 0;
    this.snapshotState.clear();
    this.lastAppliedSequence = null;
    this.lastSnapshotSeq = null;
    const channelAny = this.channel as any;
    if (typeof channelAny.emit === 'function') {
      channelAny.emit('resync', {}, { reliable: true });
    }
  }
}
