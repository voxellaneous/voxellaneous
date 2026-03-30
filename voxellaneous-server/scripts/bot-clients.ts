import geckos from '@geckos.io/client';
import polyfill from 'node-datachannel/polyfill';
import { encodeUserCmdPacket, UserCmd } from '../types';

type BotOptions = {
  id: number;
  url: string;
  port: number;
};

const DEFAULT_BOT_COUNT = 20;
const DEFAULT_HOST = 'http://127.0.0.1';
const DEFAULT_PORT = 8080;

Object.assign(globalThis, polyfill);

function parseArgNumber(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

class BotClient {
  private readonly channel;
  private inputSeq = 0;
  private moveState: UserCmd = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    descend: false,
    viewDir: { x: 0, y: 0, z: 1 },
  };
  private nextStateChangeAt = 0;
  private sendTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: BotOptions) {
    this.channel = geckos({ url: this.options.url, port: this.options.port });
  }

  start() {
    this.channel.onConnect((error) => {
      if (error) {
        console.error(`[bot ${this.options.id}] connect error:`, error.message);
        return;
      }

      console.log(`[bot ${this.options.id}] connected`);
      this.scheduleNextStateChange();
      this.sendTimer = setInterval(() => this.tick(), 1000 / 60);
    });
  }

  stop() {
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    try {
      this.channel.close();
    } catch {
      // ignore
    }
  }

  private tick() {
    const now = Date.now();
    if (now >= this.nextStateChangeAt) {
      this.scheduleNextStateChange();
    }

    const sequence = this.inputSeq >>> 0;
    this.inputSeq = (this.inputSeq + 1) >>> 0;

    const payload = encodeUserCmdPacket(this.moveState, sequence);
    if (this.channel.raw && typeof this.channel.raw.emit === 'function') {
      this.channel.raw.emit(payload);
    } else {
      this.channel.emit('userCmd', new Uint8Array(payload));
    }
  }

  private scheduleNextStateChange() {
    const now = Date.now();

    const shouldStop = Math.random() < 0.3;
    if (shouldStop) {
      this.moveState.forward = false;
      this.moveState.backward = false;
      this.moveState.left = false;
      this.moveState.right = false;
      this.nextStateChangeAt = now + randRange(500, 2500);
      return;
    }

    const angle = randRange(0, Math.PI * 2);
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);

    this.moveState.viewDir = { x: dirX, y: 0, z: dirZ };
    this.moveState.forward = true;
    this.moveState.backward = false;
    this.moveState.left = false;
    this.moveState.right = false;

    this.nextStateChangeAt = now + randRange(1000, 5000);
  }
}

function main() {
  const countArg = process.argv[2];
  const hostArg = process.argv[3];
  const portArg = process.argv[4];

  const botCount = parseArgNumber(countArg, DEFAULT_BOT_COUNT);
  const url = hostArg || DEFAULT_HOST;
  const port = parseArgNumber(portArg, DEFAULT_PORT);

  console.log(`Starting ${botCount} bots -> ${url}:${port}`);

  const bots: BotClient[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new BotClient({ id: i + 1, url, port });
    bot.start();
    bots.push(bot);
  }

  process.on('SIGINT', () => {
    console.log('Stopping bots...');
    bots.forEach((bot) => bot.stop());
    process.exit(0);
  });
}

main();
