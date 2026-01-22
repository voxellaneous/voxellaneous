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

const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

type UnknownRecord = Record<string, unknown>;

type JoinPayload = {
  peerId?: string;
  peers?: string[];
  error?: string;
};

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object';
}

function isVector3(value: unknown): value is Vector3 {
  if (!isRecord(value)) return false;
  return typeof value.x === 'number' && typeof value.y === 'number' && typeof value.z === 'number';
}

function parseJoinPayload(payload: unknown): JoinPayload | null {
  if (!isRecord(payload)) return null;
  const peers = Array.isArray(payload.peers)
    ? payload.peers.filter((id) => typeof id === 'string')
    : undefined;
  return {
    peerId: typeof payload.peerId === 'string' ? payload.peerId : undefined,
    peers,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  };
}

function parseFromPayload(payload: unknown): { from: string; sdp?: string; candidate?: string } | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.from !== 'string') return null;
  return {
    from: payload.from,
    sdp: typeof payload.sdp === 'string' ? payload.sdp : undefined,
    candidate: typeof payload.candidate === 'string' ? payload.candidate : undefined,
  };
}

function parseLeavePayload(payload: unknown): { id: string } | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.id !== 'string') return null;
  return { id: payload.id };
}

export class NetworkClient {
  private ws: WebSocket | null = null;
  private peerId: string | null = null;
  private readonly remotePlayers = new Map<string, RemotePlayerState>();
  private readonly peerConnections = new Map<string, RTCPeerConnection>();
  private readonly dataChannels = new Map<string, RTCDataChannel>();
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
    this.sendLeave('client_close');
    this.remotePlayers.clear();
    this.closePeerConnections();
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
      this.sendJoin();
    });

    ws.addEventListener('close', () => {
      this.peerId = null;
      this.remotePlayers.clear();
      this.closePeerConnections();
      if (!this.manualClose) this.scheduleReconnect();
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

  private closePeerConnections(): void {
    for (const [peerId, channel] of this.dataChannels.entries()) {
      try {
        channel.close();
      } catch {
        // ignore
      }
      this.dataChannels.delete(peerId);
    }
    for (const [peerId, pc] of this.peerConnections.entries()) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      this.peerConnections.delete(peerId);
    }
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

  private sendJoin(): void {
    this.sendJson({
      type: 'join',
      roomId: this.roomId,
      payload: { clientId: 'web-0.1' },
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
    const message = JSON.stringify({
      type: 'state',
      payload: {
        id: this.peerId,
        position: this.localState.position,
        direction: this.localState.direction,
        timestamp: Date.now(),
      },
    });
    for (const channel of this.dataChannels.values()) {
      if (channel.readyState === 'open') {
        channel.send(message);
      }
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return;
    const message = parsed;

    switch (message.type) {
      case 'join':
        this.handleJoin(message.payload);
        break;
      case 'leave':
        this.handleLeave(message.payload);
        break;
      case 'offer':
        this.handleOffer(message.payload);
        break;
      case 'answer':
        this.handleAnswer(message.payload);
        break;
      case 'ice':
        this.handleIce(message.payload);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private handleJoin(payload: unknown): void {
    const joinPayload = parseJoinPayload(payload);
    if (!joinPayload) return;
    if (joinPayload.error === 'room_full') return;
    if (joinPayload.peerId && !this.peerId) {
      this.peerId = joinPayload.peerId;
    }
    if (joinPayload.peers) {
      for (const peerId of joinPayload.peers) {
        this.maybeConnectToPeer(peerId);
      }
      return;
    }
    if (joinPayload.peerId && joinPayload.peerId !== this.peerId) {
      this.maybeConnectToPeer(joinPayload.peerId);
    }
  }

  private handleOffer(payload: unknown): void {
    const data = parseFromPayload(payload);
    if (!data || !data.sdp) return;
    const peerId = data.from;
    const pc = this.ensurePeerConnection(peerId, false);
    pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        if (!pc.localDescription) return;
        this.sendJson({
          type: 'answer',
          roomId: this.roomId,
          payload: {
            to: peerId,
            sdp: pc.localDescription.sdp,
          },
        });
      })
      .catch(() => {
        // ignore
      });
  }

  private handleAnswer(payload: unknown): void {
    const data = parseFromPayload(payload);
    if (!data || !data.sdp) return;
    const pc = this.peerConnections.get(data.from);
    if (!pc) return;
    pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }).catch(() => {
      // ignore
    });
  }

  private handleIce(payload: unknown): void {
    const data = parseFromPayload(payload);
    if (!data || !data.candidate) return;
    const pc = this.peerConnections.get(data.from);
    if (!pc) return;
    let parsedCandidate: unknown;
    try {
      parsedCandidate = JSON.parse(data.candidate);
    } catch {
      return;
    }
    if (!isRecord(parsedCandidate) || typeof parsedCandidate.candidate !== 'string') return;
    const candidate: RTCIceCandidateInit = {
      candidate: parsedCandidate.candidate,
      sdpMid: typeof parsedCandidate.sdpMid === 'string' ? parsedCandidate.sdpMid : undefined,
      sdpMLineIndex:
        typeof parsedCandidate.sdpMLineIndex === 'number' ? parsedCandidate.sdpMLineIndex : undefined,
      usernameFragment:
        typeof parsedCandidate.usernameFragment === 'string'
          ? parsedCandidate.usernameFragment
          : undefined,
    };
    pc.addIceCandidate(candidate).catch(() => {
      // ignore
    });
  }

  private handleLeave(payload: unknown): void {
    const data = parseLeavePayload(payload);
    if (!data) return;
    this.cleanupPeer(data.id);
  }

  private sendLeave(reason: string): void {
    if (!this.peerId) return;
    this.sendJson({
      type: 'leave',
      roomId: this.roomId,
      payload: {
        clientId: this.peerId,
        reason,
      },
    });
  }

  private maybeConnectToPeer(peerId: string): void {
    if (!this.peerId || peerId === this.peerId) return;
    const initiator = this.peerId.localeCompare(peerId) < 0;
    const pc = this.ensurePeerConnection(peerId, initiator);
    if (initiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          if (!pc.localDescription) return;
          this.sendJson({
            type: 'offer',
            roomId: this.roomId,
            payload: {
              to: peerId,
              sdp: pc.localDescription.sdp,
            },
          });
        })
        .catch(() => {
          // ignore
        });
    }
  }

  private ensurePeerConnection(peerId: string, initiator: boolean): RTCPeerConnection {
    const existing = this.peerConnections.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers });
    this.peerConnections.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.sendJson({
        type: 'ice',
        roomId: this.roomId,
        payload: {
          to: peerId,
          candidate: JSON.stringify(event.candidate),
        },
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        this.cleanupPeer(peerId);
        if (!this.manualClose && this.peerId) {
          this.maybeConnectToPeer(peerId);
        }
      }
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerId, event.channel);
    };

    if (initiator) {
      const channel = pc.createDataChannel('state');
      this.setupDataChannel(peerId, channel);
    }

    return pc;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    this.dataChannels.set(peerId, channel);

    channel.onmessage = (event) => {
      this.handleDataMessage(event.data);
    };
  }

  private handleDataMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type !== 'state') return;
    const payload = isRecord(parsed.payload) ? parsed.payload : null;
    if (!payload || typeof payload.id !== 'string') return;
    if (payload.id === this.peerId) return;
    if (!isVector3(payload.position) || !isVector3(payload.direction)) return;
    if (typeof payload.timestamp !== 'number') return;

    this.remotePlayers.set(payload.id, {
      id: payload.id,
      position: payload.position,
      direction: payload.direction,
      timestamp: payload.timestamp,
    });
  }

  private cleanupPeer(peerId: string): void {
    const channel = this.dataChannels.get(peerId);
    if (channel) {
      try {
        channel.close();
      } catch {
        // ignore
      }
      this.dataChannels.delete(peerId);
    }
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
      this.peerConnections.delete(peerId);
    }
    this.remotePlayers.delete(peerId);
  }
}
