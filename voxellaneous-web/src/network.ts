type Vector3 = { x: number; y: number; z: number };

export type RemotePlayerState = {
  id: string;
  position: Vector3;
  direction: Vector3;
  timestamp: number;
};

type NetworkOptions = {
  url: string;
  roomId: string;
  stateHz?: number;
  pingMs?: number;
  reconnectMs?: number;
};

type LocalState = {
  position: Vector3;
  direction: Vector3;
};

function isVector3(value: unknown): value is Vector3 {
  if (!value || typeof value !== 'object') return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

export class NetworkClient {
  private ws: WebSocket | null = null;
  private peerId: string | null = null;
  private readonly remotePlayers = new Map<string, RemotePlayerState>();
  private readonly url: string;
  private readonly roomId: string;
  private readonly stateHz: number;
  private readonly pingMs: number;
  private readonly reconnectMs: number;
  private localState: LocalState | null = null;
  private stateInterval: number | null = null;
  private pingInterval: number | null = null;
  private reconnectTimeout: number | null = null;
  private manualClose = false;

  constructor(options: NetworkOptions) {
    this.url = options.url;
    this.roomId = options.roomId;
    this.stateHz = options.stateHz ?? 20;
    this.pingMs = options.pingMs ?? 5000;
    this.reconnectMs = options.reconnectMs ?? 1000;
  }

  start(): void {
    this.manualClose = false;
    this.connect();
    this.startIntervals();
  }

  stop(): void {
    this.manualClose = true;
    this.clearIntervals();
    this.clearReconnect();
    this.remotePlayers.clear();
    this.peerId = null;
    this.closeSocket();
  }

  setLocalState(position: Vector3, direction: Vector3): void {
    this.localState = { position, direction };
  }

  getRemotePlayers(): Map<string, RemotePlayerState> {
    return this.remotePlayers;
  }

  getPeerId(): string | null {
    return this.peerId;
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      // eslint-disable-next-line no-console
      console.log('[network] connected');
      this.sendHello();
    });

    ws.addEventListener('close', () => {
      // eslint-disable-next-line no-console
      console.log('[network] disconnected');
      this.peerId = null;
      this.remotePlayers.clear();
      if (!this.manualClose) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // eslint-disable-next-line no-console
      console.log('[network] error');
    });

    ws.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });
  }

  private closeSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout !== null) return;
    this.reconnectTimeout = window.setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout === null) return;
    window.clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = null;
  }

  private startIntervals(): void {
    if (this.stateInterval === null) {
      const intervalMs = Math.round(1000 / this.stateHz);
      this.stateInterval = window.setInterval(() => this.sendState(), intervalMs);
    }
    if (this.pingInterval === null) {
      this.pingInterval = window.setInterval(() => this.sendPing(), this.pingMs);
    }
  }

  private clearIntervals(): void {
    if (this.stateInterval !== null) {
      window.clearInterval(this.stateInterval);
      this.stateInterval = null;
    }
    if (this.pingInterval !== null) {
      window.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private sendJson(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private sendHello(): void {
    this.sendJson({
      type: 'hello',
      roomId: this.roomId,
      payload: { clientVersion: 'web-0.1' },
    });
  }

  private sendPing(): void {
    this.sendJson({
      type: 'ping',
      roomId: this.roomId,
      payload: { timestamp: Date.now() },
    });
  }

  private sendState(): void {
    if (!this.peerId || !this.localState) return;
    this.sendJson({
      type: 'state',
      roomId: this.roomId,
      payload: {
        id: this.peerId,
        position: this.localState.position,
        direction: this.localState.direction,
        timestamp: Date.now(),
      },
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: { type?: unknown; payload?: unknown };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'hello':
        this.handleHello(message.payload);
        break;
      case 'state':
        this.handleState(message.payload);
        break;
      case 'leave':
        this.handleLeave(message.payload);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private handleHello(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as { peerId?: unknown; peers?: unknown };
    if (typeof data.peerId === 'string') {
      this.peerId = data.peerId;
    }
    if (Array.isArray(data.peers)) {
      // eslint-disable-next-line no-console
      console.log(`[network] peers in room: ${data.peers.length}`);
    }
  }

  private handleState(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as {
      id?: unknown;
      position?: unknown;
      direction?: unknown;
      timestamp?: unknown;
    };
    if (typeof data.id !== 'string') return;
    if (data.id === this.peerId) return;
    if (!isVector3(data.position) || !isVector3(data.direction)) return;
    if (typeof data.timestamp !== 'number') return;

    this.remotePlayers.set(data.id, {
      id: data.id,
      position: data.position,
      direction: data.direction,
      timestamp: data.timestamp,
    });
  }

  private handleLeave(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const data = payload as { id?: unknown };
    if (typeof data.id !== 'string') return;
    this.remotePlayers.delete(data.id);
  }
}
