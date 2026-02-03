import http from 'http';
import geckos, { GeckosServer, ServerChannel } from '@geckos.io/server';
import { EntityState, UserCmd, WorldSnapshot, decodeUserCmd, encodeWorldSnapshot } from './types';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const PLAYER_TIMEOUT_MS = Number.parseInt(process.env.PLAYER_TIMEOUT_MS || '300000', 10); // 5 minutes default

type PlayerEntity = EntityState & {
  channel: ServerChannel;
  input: UserCmd;
  lastInputTime: number;
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
    };

    this.players.set(playerId, player);

    // Notify player of their ID
    channel.emit('welcome', { id: playerId });

    channel.onDisconnect(() => {
      console.log(`Player disconnected: ${playerId}`);
      this.players.delete(playerId);
    });

    const handleUserCmd = (data: any) => {
      let cmd: UserCmd | null = null;
      try {
        const binary = this.normalizeUserCmdPayload(data);
        if (binary) {
          cmd = decodeUserCmd(binary);
        } else if (data && typeof data === 'object' && 'viewDir' in data) {
          // Legacy JSON fallback (should not happen in normal binary flow)
          cmd = data as UserCmd;
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

  private lastNetworkBroadcast: number = 0;
  private accumulator: number = 0;

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
    // 2. Broadcast Snapshot
    const snapshot: WorldSnapshot = {
      timestamp: timestamp,
      entities: Array.from(this.players.values()).map(p => ({
        id: p.id,
        position: p.position,
        velocity: p.velocity,
        rotation: p.rotation
      }))
    };

    const payload = encodeWorldSnapshot(snapshot);
    // Use unreliable channel for binary snapshots
    if (this.io.raw && typeof this.io.raw.emit === 'function') {
      this.io.raw.emit(payload);
    } else {
      this.io.emit('snapshot', snapshot);
    }
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
