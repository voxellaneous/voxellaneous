import geckos, { ClientChannel } from '@geckos.io/client';
import {
  EntityState,
  UserCmd,
  WorldSnapshot,
  encodeUserCmdPacket,
  decodeNetMessage,
  NetPacketType,
} from './common/types';

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
    // Geckos client configuration
    // Explicitly separate port and logic to prevent '9208' default

    // If options.url has 'http://localhost', we strip it or use it carefully.
    // Ideally we just pass { port: 8080 } and letting Geckos handle the rest works best for local,
    // but to be safe for production/network:

    const port = 8080;
    // We only want the protocol and hostname, NO PORT in the url string if we pass port separately
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

  private handleSnapshot(snapshot: WorldSnapshot) {
    if (this.lastSnapshotSeq !== null && snapshot.sequence <= this.lastSnapshotSeq) {
      return;
    }
    this.lastSnapshotSeq = snapshot.sequence;
    this.lastAppliedSequence = snapshot.sequence;
    this.latestServerSnapshotSeq = snapshot.sequence;
    this.applyInputAck(snapshot.lastProcessedInputSeq);
    this.snapshotState.clear();
    snapshot.entities.forEach((entity) => {
      this.snapshotState.set(entity.id, entity);
    });
    this.snapshots.push(snapshot);
    // Keep buffer small (e.g. 1 second worth or just 20 frames)
    if (this.snapshots.length > 30) {
      this.snapshots.shift();
    }

    // Still update this.entities for "latest" state access (reconciliation needs this)
    // But rendering will use getInterpolatedRemoteEntities
    this.entities.clear();
    snapshot.entities.forEach(entity => {
      if (entity.id !== this.myId) {
        this.entities.set(entity.id, entity);
      } else {
        // Store my own state for reconciliation
        this.entities.set('ME', entity);
      }
    });
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

    this.lastAppliedSequence = delta.sequence;
    this.lastSnapshotSeq = delta.sequence;
    this.latestServerSnapshotSeq = delta.sequence;
    this.applyInputAck(delta.lastProcessedInputSeq);

    for (const entity of delta.entities) {
      this.snapshotState.set(entity.id, entity);
    }
    for (const id of delta.removedIds) {
      this.snapshotState.delete(id);
    }

    const snapshot: WorldSnapshot = {
      timestamp: delta.timestamp,
      sequence: delta.sequence,
      lastProcessedInputSeq: delta.lastProcessedInputSeq,
      entities: Array.from(this.snapshotState.values()),
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > 30) {
      this.snapshots.shift();
    }

    this.entities.clear();
    snapshot.entities.forEach(entity => {
      if (entity.id !== this.myId) {
        this.entities.set(entity.id, entity);
      } else {
        this.entities.set('ME', entity);
      }
    });
  }

  public getRemoteEntities(): EntityState[] {
    // 60Hz Server Update -> ~16.6ms per frame.
    // We need at least 2 frames buffered (33ms). 
    // 45ms gives a safe margin for jitter.
    const INTERPOLATION_DELAY_MS = 45;
    const serverNow = Date.now() + this.serverTimeOffsetMs;

    // We assume server time is approximately local time BUT we don't have perfect sync.
    // However, the timestamps in snapshot are Server Time.
    // If we just use Date.now() - 100, we might be comparing Local Time vs Server Time.
    // These clocks might be wildly different.

    // We need to establish a time offset or just work relative to the *latest snapshot received*.
    // "Render Time" = LatestServerTime - 100ms.
    if (this.snapshots.length < 2) return [];

    const latestSnapshot = this.snapshots[this.snapshots.length - 1];
    const renderTime = serverNow - INTERPOLATION_DELAY_MS;

    // Find two snapshots surrounding renderTime
    let t1 = this.snapshots[0];
    let t2 = this.snapshots[1];

    // Iterate to find correct window
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].timestamp <= renderTime && this.snapshots[i + 1].timestamp >= renderTime) {
        t1 = this.snapshots[i];
        t2 = this.snapshots[i + 1];
        break;
      }
    }

    // Check bounds. If renderTime is older than t1 (too much lag?), clamp to t1.
    // If renderTime is newer than t2 (shouldn't happen if we use Latest - 100 and have >100ms range), clamp to t2.

    // If we are past the newest snapshot (buffer underrun), just show newest.
    if (renderTime > t2.timestamp) {
      t1 = t2; // Show latest
    }

    // Calculate alpha
    const total = t2.timestamp - t1.timestamp;
    const current = renderTime - t1.timestamp;
    let alpha = 0;
    if (total > 0) alpha = current / total;
    if (alpha < 0) alpha = 0;
    if (alpha > 1) alpha = 1;

    // Interpolate
    // Map of entities in T2 (target)
    const interpolated: EntityState[] = [];

    t2.entities.forEach(ent2 => {
      if (ent2.id === this.myId) return; // Don't interpolate self for remote view

      // Find corresponding in T1
      const ent1 = t1.entities.find(e => e.id === ent2.id);

      if (ent1) {
        // Lerp
        interpolated.push({
          id: ent2.id,
          position: {
            x: ent1.position.x + (ent2.position.x - ent1.position.x) * alpha,
            y: ent1.position.y + (ent2.position.y - ent1.position.y) * alpha,
            z: ent1.position.z + (ent2.position.z - ent1.position.z) * alpha,
          },
          velocity: ent2.velocity, // Just take latest
          rotation: ent2.rotation // TODO: Slerp rotation if needed, for now just Snap or Lerp
        });
      } else {
        // New entity, just spawn at T2 pos
        interpolated.push(ent2);
      }
    });

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
    if (this.pendingInputs.length === 0) return;
    let idx = 0;
    while (idx < this.pendingInputs.length && this.pendingInputs[idx].sequence <= lastProcessedInputSeq) {
      idx += 1;
    }
    if (idx > 0) {
      this.pendingInputs.splice(0, idx);
    }
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
