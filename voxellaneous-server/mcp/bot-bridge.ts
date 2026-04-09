// BotBridge — Playwright browser that IS the game character.
// Uses the game's real physics: gravity, ground collision, momentum.
// Movement is done by dispatching keyboard events — same as a real player.

import { chromium, Browser, Page } from 'playwright';

type Vec3 = { x: number; y: number; z: number };

export type PlayerInfo = {
  id: number;
  position: Vec3;
  distance: number;
  bearing: string;
};

function stderr(...args: unknown[]) {
  process.stderr.write(`[bot] ${args.map(String).join(' ')}\n`);
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function relativeBearing(fromYaw: number, from: Vec3, to: Vec3): string {
  const angle = Math.atan2(to.x - from.x, to.z - from.z);
  let rel = angle - fromYaw;
  rel = ((rel + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  const deg = rel * 180 / Math.PI;

  if (deg > -22.5 && deg <= 22.5) return 'ahead';
  if (deg > 22.5 && deg <= 67.5) return 'ahead-right';
  if (deg > 67.5 && deg <= 112.5) return 'right';
  if (deg > 112.5 && deg <= 157.5) return 'behind-right';
  if (deg > 157.5 || deg <= -157.5) return 'behind';
  if (deg > -157.5 && deg <= -112.5) return 'behind-left';
  if (deg > -112.5 && deg <= -67.5) return 'left';
  return 'ahead-left';
}

function cardinalFromYaw(yaw: number): string {
  const n = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const dirs = ['North', 'NW', 'West', 'SW', 'South', 'SE', 'East', 'NE'];
  return dirs[Math.round(n / (Math.PI / 4)) % 8];
}

const KEY_MAP = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
} as const;

// ---------------------------------------------------------------------------

export class BotBridge {
  private browser: Browser | null = null;
  private page: Page | null = null;

  // Cached state (synced from browser every 200ms)
  private pos: Vec3 = { x: 0, y: 0, z: 0 };
  private yaw = 0;
  private playersList: Array<{ id: number; position: Vec3 }> = [];
  private chatInbox: Array<{ name: string; text: string }> = [];
  private botName = 'Bot';
  private syncTimer: NodeJS.Timeout | null = null;

  private ready = false;
  private initPromise: Promise<void> | null = null;

  constructor(private gameClientUrl: string, name = 'Bot') {
    this.botName = name;
  }

  /** Start connecting eagerly. Tools still call ensureReady() to wait. */
  async connect(): Promise<void> {
    return this.ensureReady();
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.launch();
    await this.initPromise;
  }

  private async launch(): Promise<void> {
    stderr('Launching Chrome with WebGPU...');

    this.browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
    });

    const context = await this.browser.newContext({
      viewport: { width: 960, height: 540 },
    });
    this.page = await context.newPage();

    const url = this.gameClientUrl + (this.gameClientUrl.includes('?') ? '&' : '?') + 'bot=1';
    stderr(`Loading game from ${url}...`);
    await this.page.goto(url, { timeout: 30_000 });

    stderr('Waiting for game init...');
    await this.page.waitForFunction(
      () => (window as any).__game?.cameraModule && (window as any).__game?.characterController,
      { timeout: 60_000 },
    );

    // Set bot name
    await this.page.evaluate((name) => {
      (window as any).__setName?.(name);
    }, this.botName);

    // Inject navigation autopilot (only handles move_to steering)
    await this.page.evaluate(() => {
      const ap = {
        navTarget: null as { x: number; y: number; z: number } | null,
        navFly: false,
        navArrived: false,
        keyDown: false,
      };
      (window as any).__autopilot = ap;

      setInterval(() => {
        const app = (window as any).__game;
        if (!app?.cameraModule || !ap.navTarget) {
          if (ap.keyDown) {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
            ap.keyDown = false;
          }
          return;
        }

        const cam = app.cameraModule;
        const pos = cam.position;
        const dx = ap.navTarget.x - pos[0];
        const dy = ap.navTarget.y - pos[1];
        const dz = ap.navTarget.z - pos[2];
        const hDist = Math.sqrt(dx * dx + dz * dz);
        const fullDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const dist = ap.navFly ? fullDist : hDist;

        if (dist < 5) {
          ap.navTarget = null;
          ap.navArrived = true;
          if (ap.keyDown) {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
            ap.keyDown = false;
          }
          return;
        }

        // Steer toward target
        if (ap.navFly) {
          cam.setDirection([dx / fullDist, dy / fullDist, dz / fullDist]);
        } else if (hDist > 0.01) {
          cam.setDirection([dx / hDist, 0, dz / hDist]);
        }

        // Hold W to walk forward
        if (!ap.keyDown) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
          ap.keyDown = true;
        }
      }, 1000 / 20); // 20Hz steering
    });

    // Listen for incoming chat messages
    await this.page.exposeFunction('__botChatReceived', (name: string, text: string) => {
      this.chatInbox.push({ name, text });
    });
    await this.page.evaluate(() => {
      (window as any).__onChat?.((msg: any) => {
        (window as any).__botChatReceived(msg.name || `#${msg.playerId}`, msg.text);
      });
    });

    // Read initial position
    await this.syncState();

    // Wait for terrain to load around spawn
    await this.page.waitForTimeout(3000);
    await this.syncState();

    // Start periodic sync
    this.syncTimer = setInterval(() => this.syncState(), 200);

    this.ready = true;
    stderr(`Ready at (${this.pos.x.toFixed(0)}, ${this.pos.y.toFixed(0)}, ${this.pos.z.toFixed(0)})`);
  }

  async disconnect(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    await this.browser?.close();
    this.browser = null;
    this.page = null;
    this.ready = false;
    this.initPromise = null;
  }

  // -- State queries (sync, from cache) -------------------------------------

  getPos(): Vec3 { return { ...this.pos }; }
  getYaw(): number { return this.yaw; }
  getYawDeg(): number { return this.yaw * 180 / Math.PI; }
  getCardinal(): string { return cardinalFromYaw(this.yaw); }

  getPlayers(): PlayerInfo[] {
    return this.playersList.map(p => ({
      id: p.id,
      position: { ...p.position },
      distance: dist3(this.pos, p.position),
      bearing: relativeBearing(this.yaw, this.pos, p.position),
    })).sort((a, b) => a.distance - b.distance);
  }

  /** Returns and clears unread chat messages. */
  getNewMessages(): Array<{ name: string; text: string }> {
    return this.chatInbox.splice(0);
  }

  // -- Movement (keyboard-driven, uses game physics) ------------------------

  async walk(dir: 'forward' | 'backward' | 'left' | 'right', distance: number, run = false): Promise<Vec3> {
    await this.ensureReady();
    await this.stopNav();
    await this.syncState();
    const start = this.getPos();
    const speed = run ? 160 : 64; // wu/s
    const maxTime = (distance / speed + 2) * 1000; // generous timeout
    if (run) await this.setSpeedMultiplier(2.5);
    const code = KEY_MAP[dir];
    await this.dispatchKey('keydown', code);
    try {
      const deadline = Date.now() + maxTime;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
        await this.syncState();
        const p = this.getPos();
        const traveled = Math.hypot(p.x - start.x, p.z - start.z);
        if (traveled >= distance) break;
      }
    } finally {
      await this.dispatchKey('keyup', code);
      if (run) await this.setSpeedMultiplier(1);
    }
    await this.syncState();
    return this.getPos();
  }

  turn(deg: number): void {
    this.yaw -= deg * Math.PI / 180;
    this.page?.evaluate(({ yaw }) => {
      (window as any).__game.cameraModule.setDirection([Math.sin(yaw), 0, Math.cos(yaw)]);
    }, { yaw: this.yaw }).catch(() => {});
  }

  faceToward(x: number, z: number): void {
    this.yaw = Math.atan2(x - this.pos.x, z - this.pos.z);
    this.page?.evaluate(({ yaw }) => {
      (window as any).__game.cameraModule.setDirection([Math.sin(yaw), 0, Math.cos(yaw)]);
    }, { yaw: this.yaw }).catch(() => {});
  }

  async moveTo(x: number, y: number, z: number, fly = false, timeoutSec = 30, run = false): Promise<boolean> {
    await this.ensureReady();
    await this.stopNav();

    if (fly) await this.toggleFly(true);
    if (run) await this.setSpeedMultiplier(2.5);

    await this.page!.evaluate(({ x, y, z, fly }) => {
      const ap = (window as any).__autopilot;
      ap.navTarget = { x, y, z };
      ap.navFly = fly;
      ap.navArrived = false;
    }, { x, y, z, fly });

    const deadline = Date.now() + timeoutSec * 1000;
    let arrived = false;
    while (Date.now() < deadline) {
      arrived = await this.page!.evaluate(() => (window as any).__autopilot.navArrived);
      if (arrived) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (!arrived) await this.stopNav();
    if (run) await this.setSpeedMultiplier(1);
    if (fly) await this.toggleFly(false);

    await this.syncState();
    return arrived;
  }

  async jump(): Promise<void> {
    await this.ensureReady();
    await this.dispatchKey('keydown', 'Space');
    await new Promise(r => setTimeout(r, 50));
    await this.dispatchKey('keyup', 'Space');
    await new Promise(r => setTimeout(r, 550)); // wait for arc
  }

  async emote(type: 'spin' | 'bounce' | 'circle'): Promise<void> {
    await this.ensureReady();
    await this.stopNav();

    if (type === 'spin') {
      // Rapid 360° camera rotation — other players see the character spin
      await this.page!.evaluate(async () => {
        const cam = (window as any).__game.cameraModule;
        const startYaw = Math.atan2(cam.direction[0], cam.direction[2]);
        const dur = 800;
        const t0 = Date.now();
        await new Promise<void>(r => {
          const iv = setInterval(() => {
            const t = (Date.now() - t0) / dur;
            if (t >= 1) {
              cam.setDirection([Math.sin(startYaw), 0, Math.cos(startYaw)]);
              clearInterval(iv); r(); return;
            }
            const y = startYaw - Math.PI * 2 * t;
            cam.setDirection([Math.sin(y), 0, Math.cos(y)]);
          }, 1000 / 60);
        });
      });
    } else if (type === 'bounce') {
      // Three real jumps using game physics
      for (let i = 0; i < 3; i++) {
        await this.dispatchKey('keydown', 'Space');
        await new Promise(r => setTimeout(r, 50));
        await this.dispatchKey('keyup', 'Space');
        await new Promise(r => setTimeout(r, 550));
      }
    } else {
      // Walk forward while rotating camera = circle
      await this.page!.evaluate(async () => {
        const cam = (window as any).__game.cameraModule;
        const startYaw = Math.atan2(cam.direction[0], cam.direction[2]);
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
        const dur = 2000;
        const t0 = Date.now();
        await new Promise<void>(r => {
          const iv = setInterval(() => {
            const t = (Date.now() - t0) / dur;
            if (t >= 1) {
              cam.setDirection([Math.sin(startYaw), 0, Math.cos(startYaw)]);
              window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
              clearInterval(iv); r(); return;
            }
            const y = startYaw + Math.PI * 2 * t;
            cam.setDirection([Math.sin(y), 0, Math.cos(y)]);
          }, 1000 / 60);
        });
      });
    }
    await this.syncState();
  }

  stop(): void {
    this.page?.evaluate(() => {
      // Release all movement keys
      for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      }
      const ap = (window as any).__autopilot;
      ap.navTarget = null;
      ap.keyDown = false;
    }).catch(() => {});
  }

  // -- Chat ----------------------------------------------------------------

  async sendChat(text: string): Promise<void> {
    await this.ensureReady();
    await this.page!.evaluate((text) => {
      (window as any).__sendChat?.(text);
    }, text);
  }

  // -- Screenshot -----------------------------------------------------------

  async screenshot(yaw: number, pitch = 0): Promise<Buffer> {
    await this.ensureReady();
    const page = this.page!;

    // Save current direction, look for the screenshot, then restore
    await page.evaluate(({ yaw, pitch }) => {
      const cam = (window as any).__game.cameraModule;
      (window as any).__savedDir = [cam.direction[0], cam.direction[1], cam.direction[2]];
      cam.setDirection([
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw),
      ]);
    }, { yaw, pitch });

    // Wait for terrain + render
    await page.waitForTimeout(800);
    await page.evaluate(() =>
      new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

    const png = await page.screenshot({ type: 'png' });

    // Restore original direction
    await page.evaluate(() => {
      const cam = (window as any).__game.cameraModule;
      const d = (window as any).__savedDir;
      if (d) cam.setDirection(d);
    });

    return png;
  }

  // -- Internal -------------------------------------------------------------

  private async setSpeedMultiplier(mult: number): Promise<void> {
    await this.page?.evaluate((m) => {
      const cc = (window as any).__game?.characterController;
      if (cc) cc.config.walkSpeed = 64 * m;
    }, mult);
  }

  private async dispatchKey(type: 'keydown' | 'keyup', code: string): Promise<void> {
    await this.page?.evaluate(({ type, code }) => {
      window.dispatchEvent(new KeyboardEvent(type, { code }));
    }, { type, code });
  }

  private async toggleFly(enable: boolean): Promise<void> {
    const isFlying = await this.page!.evaluate(() =>
      (window as any).__game.characterController.isFlying,
    );
    if (isFlying !== enable) {
      await this.page!.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF' }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF' }));
      });
    }
  }

  private async stopNav(): Promise<void> {
    await this.page?.evaluate(() => {
      const ap = (window as any).__autopilot;
      ap.navTarget = null;
      if (ap.keyDown) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
        ap.keyDown = false;
      }
    });
  }

  private async syncState(): Promise<void> {
    if (!this.page) return;
    try {
      const state = await this.page.evaluate(() => {
        const app = (window as any).__game;
        const net = (window as any).__network;
        const pos = app.cameraModule.position;
        const dir = app.cameraModule.direction;
        const entities = net?.getRemoteEntities?.() ?? [];
        return {
          x: pos[0] as number, y: pos[1] as number, z: pos[2] as number,
          yaw: Math.atan2(dir[0] as number, dir[2] as number),
          players: entities.map((e: any) => ({
            id: e.id,
            position: { x: e.position.x, y: e.position.y, z: e.position.z },
          })),
        };
      });
      this.pos = { x: state.x, y: state.y, z: state.z };
      this.yaw = state.yaw;
      this.playersList = state.players;
    } catch { /* page might be navigating */ }
  }
}
