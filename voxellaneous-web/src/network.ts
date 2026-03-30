import geckos, { ClientChannel } from '@geckos.io/client';
import {
  EntityState,
  UserCmd,
  WorldSnapshot,
  encodeUserCmdPacket,
  decodeNetMessage,
  NetPacketType,
} from '../../voxellaneous-common/src/netcode';

type NetworkOptions = {
  url: string;
  timeSync?: {
    maxRttMs?: number;
    windowSize?: number;
    smoothing?: number;
  };
};

export class NetworkClient {
  private channel: ClientChannel;
  private entities: Map<number | 'ME', EntityState> = new Map();
  private myId: number | null = null;
  private snapshots: WorldSnapshot[] = [];
  private lastSnapshotSeq: number | null = null;
  private isConnected = false;
  private serverTimeOffsetMs = 0;
  private lastRttMs = 0;
  private timeOffsetSamples: number[] = [];
  private readonly timeOffsetWindow: number;
  private readonly maxRttMs: number;
  private readonly timeOffsetSmoothing: number;
  private pingIntervalId: number | null = null;
  private snapshotState: Map<number, EntityState> = new Map();
  private lastAppliedSequence: number | null = null;
  private latestServerSnapshotSeq: number | null = null;
  private inputSequence: number = 0;
  private pendingInputs: Array<{ sequence: number; cmd: UserCmd; dt: number }> = [];
  private lastResyncAt = 0;

  constructor(options: NetworkOptions) {
    const port = 8080;
    const url = `${window.location.protocol}//${window.location.hostname}`;

    console.log(`Connecting to Geckos: url=${url}, port=${port}`);
    this.channel = geckos({ url, port });

    this.maxRttMs = options.timeSync?.maxRttMs ?? 200;
    this.timeOffsetWindow = options.timeSync?.windowSize ?? 10;
    this.timeOffsetSmoothing = options.timeSync?.smoothing ?? 0.2;

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
      });

      this.channel.on('snapshot', (data: any) => {
        this.handleSnapshot(data as WorldSnapshot);
      });

      this.channel.on('pong', (data: any) => {
        if (!data || typeof data.clientTime !== 'number' || typeof data.serverTime !== 'number') return;
        const now = Date.now();
        const rtt = now - data.clientTime;
        this.lastRttMs = rtt;
        if (rtt > this.maxRttMs) return;
        const estimate = data.serverTime - (data.clientTime + rtt / 2);
        this.pushTimeOffsetSample(estimate);
      });

      if (this.pingIntervalId === null) {
        this.pingIntervalId = window.setInterval(() => {
          const clientTime = Date.now();
          this.channel.emit('ping', { clientTime });
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

  public sendInput(cmd: UserCmd, dt: number) {
    if (!this.isConnected) return;
    // Binary Optimized
    const sequence = this.inputSequence >>> 0;
    this.inputSequence = (this.inputSequence + 1) >>> 0;
    this.pendingInputs.push({ sequence, cmd, dt });
    const buffer = encodeUserCmdPacket(cmd, sequence);
    if (this.channel.raw && typeof this.channel.raw.emit === 'function') {
      this.channel.raw.emit(buffer);
      return;
    }
    this.channel.emit('userCmd', new Uint8Array(buffer));
  }

  private applySnapshot(snapshot: WorldSnapshot) {
    this.lastSnapshotSeq = snapshot.sequence;
    this.lastAppliedSequence = snapshot.sequence;
    this.latestServerSnapshotSeq = snapshot.sequence;
    this.applyInputAck(snapshot.lastProcessedInputSeq);

    this.snapshots.push(snapshot);
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

    const renderTime = Date.now() + this.serverTimeOffsetMs - INTERPOLATION_DELAY_MS;

    // Find two snapshots surrounding renderTime
    let t1 = this.snapshots[0];
    let t2 = this.snapshots[1];
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].timestamp <= renderTime && this.snapshots[i + 1].timestamp >= renderTime) {
        t1 = this.snapshots[i];
        t2 = this.snapshots[i + 1];
        break;
      }
    }

    // Buffer underrun — show latest
    if (renderTime > t2.timestamp) t1 = t2;

    const total = t2.timestamp - t1.timestamp;
    const alpha = Math.max(0, Math.min(1, total > 0 ? (renderTime - t1.timestamp) / total : 0));

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
          rotation: ent2.rotation,
        });
      } else {
        interpolated.push(ent2);
      }
    }
    return interpolated;
  }

  public getMyLatestState(): EntityState | undefined {
    return this.entities.get('ME');
  }

  public getLatestSnapshotSequence(): number | null {
    return this.latestServerSnapshotSeq;
  }
  public getMyId(): number | null {
    return this.myId;
  }

  public getPingMs(): number {
    return this.lastRttMs;
  }

  private pushTimeOffsetSample(estimate: number) {
    this.timeOffsetSamples.push(estimate);
    if (this.timeOffsetSamples.length > this.timeOffsetWindow) {
      this.timeOffsetSamples.shift();
    }
    const sorted = [...this.timeOffsetSamples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    this.serverTimeOffsetMs = this.serverTimeOffsetMs + (median - this.serverTimeOffsetMs) * this.timeOffsetSmoothing;
  }

  public getPendingInputs(): Array<{ sequence: number; cmd: UserCmd; dt: number }> {
    return this.pendingInputs;
  }

  private applyInputAck(lastProcessedInputSeq: number) {
    const idx = this.pendingInputs.findIndex(i => i.sequence > lastProcessedInputSeq);
    if (idx === -1) this.pendingInputs.length = 0;
    else if (idx > 0) this.pendingInputs.splice(0, idx);
  }

  private requestResync() {
    const now = Date.now();
    if (now - this.lastResyncAt < 1000) return;
    this.lastResyncAt = now;
    this.snapshots.length = 0;
    this.snapshotState.clear();
    this.lastAppliedSequence = null;
    this.lastSnapshotSeq = null;
    const payload = {
      lastSnapshotSeq: this.latestServerSnapshotSeq,
    };
    const channelAny = this.channel as any;
    if (typeof channelAny.emit === 'function') {
      channelAny.emit('resync', payload, { reliable: true });
    }
  }
}
