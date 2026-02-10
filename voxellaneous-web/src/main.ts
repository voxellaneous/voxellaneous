import { CameraModule } from './camera';
import { LocalPlayer } from './local-player';
import './style.css';

import { Renderer } from './renderer';
import { initializeDevTools } from './editor';
import { importFromBinary, createSceneFromResult } from './converter';
import { Scene, VoxelObject } from './scene';
import { ProfilerData, updateProfilerData } from './profiler-data';
import { vec3 } from 'gl-matrix';
import { NetworkClient } from './network';
import { mat4 } from 'gl-matrix';
import { ByteArray } from '../../voxellaneous-common/src/byte-array';

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

  const player = new LocalPlayer([-100, -470, -356]);
  cameraModule.setPosition(player.position as vec3);

  const { autoresizeCanvas } = createCanvasAutoresize(app);

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
  if (baseScene.palette.length <= 254) {
    const missing = 255 - baseScene.palette.length;
    for (let i = 0; i < missing; i++) {
      baseScene.palette.push([0, 0, 0, 0]);
    }
  }
  baseScene.palette[254] = [0, 0, 0, 255];

  const markerVoxels = createUniformVoxelData(remoteMarkerSize, 254);

  // Tracking known players to avoid re-uploading scene
  const knownRemotePlayers = new Set<string>();

  const updateRemoteScene = () => {
    const remoteEntities = network.getRemoteEntities();
    const currentIds = new Set(remoteEntities.map(e => `remote_${e.id}`));

    let structureChanged = false;
    for (const id of currentIds) {
      if (!knownRemotePlayers.has(id)) {
        structureChanged = true;
        break;
      }
    }
    if (!structureChanged && knownRemotePlayers.size !== currentIds.size) {
      structureChanged = true;
    }

    if (structureChanged) {
      console.log('Structure changed, re-uploading scene');
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
      for (const entity of remoteEntities) {
        const id = `remote_${entity.id}`;
        const obj = createRemoteMarkerObject(entity.id, entity.position, markerVoxels);

        const uniformData = new Float32Array(32);
        uniformData.set(obj.modelMatrix, 0);
        uniformData.set(obj.invModelMatrix, 16);

        renderer.updateObjectTransform(id, uniformData);
      }
    }
  };

  const remoteSceneInterval = window.setInterval(updateRemoteScene, 20);
  window.addEventListener('beforeunload', () => {
    window.clearInterval(remoteSceneInterval);
  });

  let lastReconciledSeq: number | null = null;

  // RENDER LOOP
  const render: FrameRequestCallback = (time) => {
    autoresizeCanvas();
    updateProfilerData(profilerData, time);
    profilerData.pingMs = network.getPingMs();

    const dt = profilerData.frameTime / 1000;
    cameraModule.update();

    if (cameraModule.isFocused()) {
      const cmd = cameraModule.getUserCmd();
      player.applyUserCmd(cmd, dt);
      cameraModule.setPosition(player.position as vec3);
      network.sendInput(cmd, dt);
    }

    // Server Reconciliation
    const serverState = network.getMyLatestState();
    const snapshotSeq = network.getLatestSnapshotSequence();
    if (serverState && snapshotSeq !== null && snapshotSeq !== lastReconciledSeq) {
      lastReconciledSeq = snapshotSeq;
      const pending = network.getPendingInputs();
      const { x: sx, y: sy, z: sz } = serverState.position;
      const [px, py, pz] = player.position;

      const dx = sx - px;
      const dy = sy - py;
      const dz = sz - pz;
      const distSq = dx * dx + dy * dy + dz * dz;

      const SNAP_THRESHOLD = 5.0;
      const CORRECTION_THRESHOLD = 0.5;
      const LERP_FACTOR = 0.1;

      if (pending.length > 0) {
        player.setPosition([sx, sy, sz]);
        for (const input of pending) {
          player.applyUserCmd(input.cmd, input.dt);
        }
      } else if (distSq > SNAP_THRESHOLD * SNAP_THRESHOLD) {
        console.warn('Reconciliation hard snap!', distSq);
        player.setPosition([sx, sy, sz]);
      } else if (distSq > CORRECTION_THRESHOLD * CORRECTION_THRESHOLD) {
        const nx = px + (sx - px) * LERP_FACTOR;
        const ny = py + (sy - py) * LERP_FACTOR;
        const nz = pz + (sz - pz) * LERP_FACTOR;
        player.setPosition([nx, ny, nz]);
      }
      cameraModule.setPosition(player.position as vec3);
    }

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
