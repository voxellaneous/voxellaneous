import geckos, { ClientChannel } from '@geckos.io/client';
import { EntityState, UserCmd, WorldSnapshot, encodeUserCmd, decodeWorldSnapshot } from './common/types';

type NetworkOptions = {
  url: string;
};



export class NetworkClient {
  private channel: ClientChannel;
  private entities: Map<string, EntityState> = new Map();
  private myId: number | null = null;
  private snapshots: WorldSnapshot[] = [];
  private isConnected = false;

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

      const rawChannel = this.channel as any;
      if (typeof rawChannel.onRaw === 'function') {
        rawChannel.onRaw((data: any) => {
          try {
            const snapshot = decodeWorldSnapshot(data);
            this.handleSnapshot(snapshot);
          } catch (e) {
            console.error('Failed to decode binary snapshot:', e);
          }
        });
      }
    });
  }

  public sendInput(cmd: UserCmd) {
    if (!this.isConnected) return;
    // Binary Optimized
    const buffer = encodeUserCmd(cmd);
    if (this.channel.raw && typeof this.channel.raw.emit === 'function') {
      this.channel.raw.emit(buffer);
      return;
    }
    this.channel.emit('userCmd', new Uint8Array(buffer));
  }

  private handleSnapshot(snapshot: WorldSnapshot) {
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

  public getRemoteEntities(): EntityState[] {
    // 60Hz Server Update -> ~16.6ms per frame.
    // We need at least 2 frames buffered (33ms). 
    // 45ms gives a safe margin for jitter.
    const INTERPOLATION_DELAY_MS = 45;
    const now = Date.now();

    // We assume server time is approximately local time BUT we don't have perfect sync.
    // However, the timestamps in snapshot are Server Time.
    // If we just use Date.now() - 100, we might be comparing Local Time vs Server Time.
    // These clocks might be wildly different.

    // We need to establish a time offset or just work relative to the *latest snapshot received*.
    // "Render Time" = LatestServerTime - 100ms.
    if (this.snapshots.length < 2) return [];

    const latestSnapshot = this.snapshots[this.snapshots.length - 1];
    const renderTime = latestSnapshot.timestamp - INTERPOLATION_DELAY_MS;

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

  public getMyId(): number | null {
    return this.myId;
  }
}
