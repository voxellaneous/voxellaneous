import { CameraModule } from './camera';
import './style.css';

import { Renderer } from './renderer';
import { initializeDevTools } from './editor';
import { importFromBinary, createSceneFromResult } from './converter';
import { Scene, VoxelObject } from './scene';
import { ProfilerData, updateProfilerData } from './profiler-data';
import { vec3 } from 'gl-matrix';
import { NetworkClient } from './network';
import { mat4 } from 'gl-matrix';
import { ByteArray, UserCmd, EntityState } from './common/types';

const remoteMarkerSize = 4;

function createUniformVoxelData(size: number, paletteIndex: number): ByteArray {
  const total = size * size * size;
  const voxels = new ByteArray(new ArrayBuffer(total));
  voxels.fill(paletteIndex);
  return voxels;
}

function createRemoteMarkerObject(
  id: number,
  position: { x: number; y: number; z: number },
  voxels: ByteArray,
): VoxelObject {
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, [position.x, position.y, position.z]);
  mat4.scale(modelMatrix, modelMatrix, [remoteMarkerSize, remoteMarkerSize, remoteMarkerSize]);
  const inverseModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  return {
    id: `remote_${id}`,
    dims: vec3.fromValues(remoteMarkerSize, remoteMarkerSize, remoteMarkerSize),
    modelMatrix,
    invModelMatrix: inverseModelMatrix,
    voxels,
  };
}

function buildRemoteSignature(
  remotePlayers: Map<string, EntityState>,
) {
  const entries = Array.from(remotePlayers.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((player) => {
      const { x, y, z } = player.position;
      return `${player.id}:${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
    });
  return entries.join('|');
}

export type AppData = {
  renderer: Renderer;
  presentTarget: number;
  canvas: HTMLCanvasElement;
  lightDir: { x: number; y: number; z: number };
  ambient: number;
  lightIntensity: number;
  showBboxes: boolean;
};

function createCanvasAutoresize({ renderer, canvas }: AppData): { autoresizeCanvas: VoidFunction } {
  let newCanvasSize: { width: number; height: number } | undefined;

  const observer = new ResizeObserver((rects) => {
    const rect = rects[0].contentRect;
    newCanvasSize = rect;
  });
  observer.observe(canvas);

  const autoresizeCanvas = () => {
    if (!newCanvasSize) return;

    canvas.width = newCanvasSize.width;
    canvas.height = newCanvasSize.height;
    renderer.resize(canvas.width, canvas.height);
    newCanvasSize = undefined;
  };

  return { autoresizeCanvas };
}

function registerRecurringAnimation(f: FrameRequestCallback): void {
  const loop: FrameRequestCallback = (t) => {
    f(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// function setupInputListeners() { ... } removed - using CameraModule directly

async function initializeApp(): Promise<AppData> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;

  // Use port 8080 for Geckos server (handled in NetworkClient default or passed explicitly)
  const network = new NetworkClient({ url: `http://${window.location.hostname}` });

  const renderer = await Renderer.new(canvas);
  const app: AppData = {
    renderer,
    canvas,
    presentTarget: 4, // Default to Lit mode
    lightDir: { x: 0.22, y: 0.22, z: 0.56 },
    ambient: 0.3,
    lightIntensity: 1.0,
    showBboxes: false,
  };
  const profilerData: ProfilerData = { fps: 0, frameTime: 0, pingMs: 0, lastTimeStamp: 0 };

  const cameraModule = new CameraModule(canvas);
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0.5, 0, -1]));
  cameraModule.setPosition([-100, -470, -356]);

  const { autoresizeCanvas } = createCanvasAutoresize(app);

  // setupInputListeners(); // Handled by CameraModule


  // Load sponza scene
  let baseScene: Scene = { palette: [], objects: [] };
  try {
    const response = await fetch('/resources/sponza.voxgz');
    if (response.ok) {
      const blob = await response.blob();
      const file = new File([blob], 'sponza.voxgz');
      const result = await importFromBinary(file);
      baseScene = createSceneFromResult(result);
    }
  } catch (e) {
    console.warn('Failed to load sponza:', e);
  }
  renderer.uploadScene(baseScene);

  // Reserve index 254 for player markers (black color)
  // Using 254 to avoid overwriting colors that might be used by the scene
  // Scene palette is RGBA[] (tuples of numbers), NOT flat Uint32Array
  if (baseScene.palette.length <= 254) {
    const missing = 255 - baseScene.palette.length;
    for (let i = 0; i < missing; i++) {
      baseScene.palette.push([0, 0, 0, 0]);
    }
  }

  // Set index 254 to Black [0, 0, 0, 255] for player markers
  baseScene.palette[254] = [0, 0, 0, 255];

  const markerVoxels = createUniformVoxelData(remoteMarkerSize, 254);

  // Tracking known players to avoid re-uploading scene
  const knownRemotePlayers = new Set<string>();

  const updateRemoteScene = () => {
    const remoteEntities = network.getRemoteEntities();
    const currentIds = new Set(remoteEntities.map(e => `remote_${e.id}`));

    // Check if structure changed (New player joined OR Player left)
    let structureChanged = false;

    // Check for new players
    for (const id of currentIds) {
      if (!knownRemotePlayers.has(id)) {
        structureChanged = true;
        break;
      }
    }
    // Check for left players (if structure hasn't already marked changed)
    if (!structureChanged && knownRemotePlayers.size !== currentIds.size) {
      structureChanged = true;
    }

    if (structureChanged) {
      console.log('Structure changed, re-uploading scene');
      // Full rebuild
      knownRemotePlayers.clear();
      currentIds.forEach(id => knownRemotePlayers.add(id));

      const remoteObjects = remoteEntities.map((entity) =>
        createRemoteMarkerObject(entity.id, entity.position, markerVoxels),
      );

      const scene: Scene = {
        palette: baseScene.palette,
        objects: [...baseScene.objects, ...remoteObjects],
      };
      renderer.uploadScene(scene);
    } else {
      // Fast update: just transforms
      for (const entity of remoteEntities) {
        const id = `remote_${entity.id}`;
        // Re-calculate matrix for this position
        // (We could optimize createRemoteMarkerObject to return just matrix too, but it's cheap)
        const obj = createRemoteMarkerObject(entity.id, entity.position, markerVoxels);

        // Render expects matrix + inverse. 
        // updateObjectTransform updates internal buffer with modelMatrix (offset 0) and invModelMatrix (offset 64 bytes = 16 floats)
        // But our updateObjectTransform only took modelMatrix?
        // Let's check renderer implementation again. 
        // Ah, we passed modelMatrix but wrote it. We need to write BOTH.
        // Let's assume we fix renderer or pass a combined buffer?
        // Actually, for now, let's just construct the Float32Array(32) here? 
        // No, the renderer method signature was `updateObjectTransform(id: string, modelMatrix: Float32Array)`.
        // Ideally we pass 32 floats.

        const uniformData = new Float32Array(32);
        uniformData.set(obj.modelMatrix, 0);
        uniformData.set(obj.invModelMatrix, 16);

        renderer.updateObjectTransform(id, uniformData);
      }
    }
  };

  const remoteSceneInterval = window.setInterval(updateRemoteScene, 20); // 50fps smooth updates
  window.addEventListener('beforeunload', () => {
    window.clearInterval(remoteSceneInterval);
  });

  let lastReconciledSeq: number | null = null;

  // RENDER LOOP
  const render: FrameRequestCallback = (time) => {
    autoresizeCanvas();
    updateProfilerData(profilerData, time);
    profilerData.pingMs = network.getPingMs();

    // Client Side Prediction (Visual Only for now)
    // Profiler data frameTime is in ms, we need seconds
    const dt = profilerData.frameTime / 1000;
    cameraModule.update(dt);

    // Send Input to Server (block when not focused)
    if (cameraModule.isFocused()) {
      const cmd = cameraModule.getUserCmd();
      network.sendInput(cmd, dt);
    }

    // Server Reconciliation
    // Check if server disagrees with our position
    const serverState = network.getMyLatestState();
    const snapshotSeq = network.getLatestSnapshotSequence();
    if (serverState && snapshotSeq !== null && snapshotSeq !== lastReconciledSeq) {
      lastReconciledSeq = snapshotSeq;
      const pending = network.getPendingInputs();
      const { x: sx, y: sy, z: sz } = serverState.position;
      const [cx, cy, cz] = cameraModule.position;

      const dx = sx - cx;
      const dy = sy - cy;
      const dz = sz - cz;
      const distSq = dx * dx + dy * dy + dz * dz;

      // Thresholds
      const SNAP_THRESHOLD = 5.0; // If > 5 units away, snap (teleport)
      const CORRECTION_THRESHOLD = 0.5; // If > 0.5 units, lerp
      const LERP_FACTOR = 0.1; // 10% correction per frame (~6x speed towards target)

      if (pending.length > 0) {
        // Replay pending inputs from authoritative state
        cameraModule.setPosition([sx, sy, sz]);
        for (const input of pending) {
          cameraModule.applyUserCmd(input.cmd, input.dt);
        }
      } else if (distSq > SNAP_THRESHOLD * SNAP_THRESHOLD) {
        // Snap
        console.warn('Reconciliation hard snap!', distSq);
        cameraModule.setPosition([sx, sy, sz]);
      } else if (distSq > CORRECTION_THRESHOLD * CORRECTION_THRESHOLD) {
        // Smooth correction
        const nx = cx + (sx - cx) * LERP_FACTOR;
        const ny = cy + (sy - cy) * LERP_FACTOR;
        const nz = cz + (sz - cz) * LERP_FACTOR;
        cameraModule.setPosition([nx, ny, nz]);
      }
    }

    // updateRemoteScene is now in interval

    const mvpMatrix = cameraModule.calculateMVP();
    const lightDirArray = new Float32Array([app.lightDir.x, app.lightDir.y, app.lightDir.z]);
    renderer.render(
      new Float32Array(mvpMatrix),
      new Float32Array(cameraModule.position),
      app.presentTarget,
      lightDirArray,
      app.ambient,
      app.lightIntensity,
      app.showBboxes,
    );
  };
  registerRecurringAnimation(render);

  initializeDevTools(app, profilerData);

  // Hide loading indicator
  document.getElementById('loading')?.classList.add('hidden');

  return app;
}

export const App = await initializeApp();
