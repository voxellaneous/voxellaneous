import { CameraModule } from './camera';
import { LocalPlayer } from './local-player';
import './style.css';

import { Renderer } from './renderer';
import { isMobileDevice, MOBILE_QUALITY, DESKTOP_QUALITY } from './renderer/types';
import { initializeDevTools } from './editor';
import { importFromBinary, createSceneFromResult } from './converter';
import { VoxelObject, RGBA } from './scene';
import { ProfilerData, updateProfilerData } from './profiler-data';
import { vec3 } from 'gl-matrix';
import { NetworkClient } from './network';
import { mat4 } from 'gl-matrix';
import { ByteArray } from './common/types';
import { ChunkManager, ShadowClipmapManager } from './terrain';
import { CharacterController } from './character-controller';
import { TouchInput } from './touch-input';

const remoteMarkerSize = 4;
const reusableMvp = new Float32Array(16);
const reusableCamPos = new Float32Array(3);
const reusableLightDir = new Float32Array(3);
const markerPalette: RGBA[] = [
  [0, 0, 0, 0], // Index 0: empty
  [255, 0, 0, 255], // Index 1: red marker
];

function createUniformVoxelData(size: number, paletteIndex: number): ByteArray {
  const total = size * size * size;
  const voxels = new ByteArray(total);
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
    palette: markerPalette,
  };
}

export type AppData = {
  renderer: Renderer;
  presentTarget: number;
  canvas: HTMLCanvasElement;
  sunTime: number;
  sunAngle: number;
  ambient: number;
  sunIlluminance: number;
  sunDiskScale: number;
  sunDiskSize: number;
  showBboxes: boolean;
  terrainManager?: ChunkManager;
  cameraModule?: CameraModule;
  characterController?: CharacterController;
  cameraSpeed: number;
  hazeDensity: number;
  fogDensity: number;
  fogFalloff: number;
  sunTimeScale: number;
  sunOccSpeed: number;
  sponzaPosition: { x: number; y: number; z: number };
  repositionSponza?: () => void;
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

async function initializeApp(): Promise<AppData> {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas')!;

  const network = new NetworkClient({ url: `http://${window.location.hostname}` });

  const quality = isMobileDevice() ? MOBILE_QUALITY : DESKTOP_QUALITY;
  const renderer = await Renderer.new(canvas, quality);
  const cameraModule = new CameraModule(canvas);
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0, 0, 1]));

  const player = new LocalPlayer([3770, 300, 620]);
  cameraModule.setPosition(player.position as vec3);

  const app: AppData = {
    renderer,
    canvas,
    presentTarget: 4, // Default to Lit mode
    sunTime: 8,
    sunAngle: 260,
    ambient: 0.15,
    sunIlluminance: 10,
    sunDiskScale: 0.8,
    sunDiskSize: 2,
    showBboxes: false,
    cameraModule,
    cameraSpeed: cameraModule.speed,
    hazeDensity: 0.0004,
    fogDensity: 0,
    fogFalloff: 0.01,
    sunTimeScale: 0,
    sunOccSpeed: 0.5,
    sponzaPosition: quality === MOBILE_QUALITY ? { x: 3770, y: 500, z: 620 } : { x: 3770, y: 755, z: 620 },
  };
  const profilerData: ProfilerData = { fps: 0, frameTime: 0, pingMs: 0, lastTimeStamp: 0 };

  const { autoresizeCanvas } = createCanvasAutoresize(app);

  // Load sponza scene
  let sponzaBaseObjects: VoxelObject[] = [];
  try {
    const sponzaFile = quality === MOBILE_QUALITY ? 'sponza-small.voxgz' : 'sponza.voxgz';
    const response = await fetch(`/resources/${sponzaFile}`);
    if (response.ok) {
      const blob = await response.blob();
      const file = new File([blob], 'sponza.voxgz');
      const result = await importFromBinary(file);
      const sponzaScene = createSceneFromResult(result);
      sponzaBaseObjects = sponzaScene.objects.map((obj) => ({
        ...obj,
        palette: sponzaScene.palette,
      }));
    }
  } catch (e) {
    console.warn('Failed to load sponza:', e);
  }

  // Initialize terrain manager with LOD levels
  const terrainManager = new ChunkManager({ lodLevels: quality.lodLevels }, quality.maxPendingChunkRequests);
  app.terrainManager = terrainManager;

  const shadowClipmap = new ShadowClipmapManager(terrainManager.getChunkCache(), terrainManager.getConfig());

  const characterController = new CharacterController();
  characterController.setFromEyePosition(cameraModule.position);
  app.characterController = characterController;

  const toggleFly = () => {
    characterController.toggleFlyWalk();
    if (!characterController.isFlying) {
      characterController.setFromEyePosition(cameraModule.position);
    }
    touchInput?.setFlyActive(characterController.isFlying);
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && !e.repeat) {
      toggleFly();
    }
  });

  // Touch input for mobile
  const isMobile = window.matchMedia('(pointer: coarse)').matches;
  const touchInput = isMobile ? new TouchInput(canvas, toggleFly) : null;

  function offsetSponza(base: VoxelObject[], pos: { x: number; y: number; z: number }): VoxelObject[] {
    return base.map((obj) => {
      const m = mat4.clone(obj.modelMatrix);
      m[12] += pos.x;
      m[13] += pos.y;
      m[14] += pos.z;
      return { ...obj, modelMatrix: m, invModelMatrix: mat4.invert(mat4.create(), m)! };
    });
  }

  // Upload sponza with initial position
  renderer.uploadStaticObjects(offsetSponza(sponzaBaseObjects, app.sponzaPosition), []);
  app.repositionSponza = () => {
    renderer.uploadStaticObjects(offsetSponza(sponzaBaseObjects, app.sponzaPosition), []);
  };

  // Initial terrain load (dynamic)
  terrainManager.update(cameraModule.position);
  renderer.uploadScene({
    palette: [],
    objects: [],
    heightmapObjects: terrainManager.getVisibleHeightmapChunks(),
  });

  const markerVoxels = createUniformVoxelData(remoteMarkerSize, 1);

  // Tracking known remote players to avoid unnecessary scene re-uploads
  const knownRemotePlayers = new Set<string>();

  const updateRemoteScene = () => {
    const remoteEntities = network.getRemoteEntities();
    const currentIds = new Set(remoteEntities.map((e) => `remote_${e.id}`));

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
      knownRemotePlayers.clear();
      currentIds.forEach((id) => knownRemotePlayers.add(id));
    }

    const remoteObjects = remoteEntities.map((entity) =>
      createRemoteMarkerObject(entity.id, entity.position, markerVoxels),
    );
    const heightmapChunks = app.terrainManager!.getVisibleHeightmapChunks();
    renderer.uploadScene({
      palette: [],
      objects: remoteObjects,
      heightmapObjects: heightmapChunks,
    });
  };

  const remoteSceneInterval = window.setInterval(updateRemoteScene, 100);
  window.addEventListener('beforeunload', () => {
    window.clearInterval(remoteSceneInterval);
  });

  let lastReconciledSeq: number | null = null;

  // NOW start render loop after scene is uploaded
  let lastFrameTime = 0;
  const render: FrameRequestCallback = (time) => {
    const dt = lastFrameTime === 0 ? 1 / 60 : Math.min((time - lastFrameTime) / 1000, 0.1);
    lastFrameTime = time;

    autoresizeCanvas();
    updateProfilerData(profilerData, time);
    profilerData.pingMs = network.getPingMs();

    cameraModule.updateLook();

    // Apply touch look
    if (touchInput) {
      const { dx, dy } = touchInput.consumeLookDelta();
      if (dx !== 0 || dy !== 0) {
        cameraModule.applyLookDelta(dx, dy);
      }
    }

    // Send input to server and apply locally via LocalPlayer
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

      const ddx = sx - px;
      const ddy = sy - py;
      const ddz = sz - pz;
      const distSq = ddx * ddx + ddy * ddy + ddz * ddz;

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

    // Update terrain chunks based on camera position
    const terrainChanged = app.terrainManager!.update(cameraModule.position);
    if (terrainChanged) {
      const remoteEntities = network.getRemoteEntities();
      const heightmapChunks = app.terrainManager!.getVisibleHeightmapChunks();
      const remoteObjects = remoteEntities.map((entity) =>
        createRemoteMarkerObject(entity.id, entity.position, markerVoxels),
      );
      renderer.uploadScene({
        palette: [],
        objects: remoteObjects,
        heightmapObjects: heightmapChunks,
      });
    }

    // Update shadow clipmap from terrain cache and upload dirty levels
    if (shadowClipmap.update(cameraModule.position[0], cameraModule.position[2], terrainManager.cacheGeneration)) {
      renderer.uploadShadowClipmap(shadowClipmap);
    }

    const mvpMatrix = cameraModule.calculateMVP();
    const { inverseView, inverseProjection } = cameraModule.getCameraMatrices();
    reusableMvp.set(mvpMatrix);
    reusableCamPos.set(cameraModule.position);

    // Advance time of day
    if (app.sunTimeScale > 0) {
      app.sunTime = (app.sunTime + dt * app.sunTimeScale) % 24;
    }

    // Sun traces a great circle tilted 75° from the horizon
    const tilt = (75 * Math.PI) / 180;
    const phase = ((app.sunTime - 6) / 24) * 2 * Math.PI;
    const sx = Math.cos(phase);
    const sy = Math.sin(phase) * Math.sin(tilt);
    const sz = -Math.sin(phase) * Math.cos(tilt);
    const azimRad = (app.sunAngle * Math.PI) / 180;
    reusableLightDir[0] = sx * Math.cos(azimRad) + sz * Math.sin(azimRad);
    reusableLightDir[1] = sy;
    reusableLightDir[2] = -sx * Math.sin(azimRad) + sz * Math.cos(azimRad);

    renderer.render(
      reusableMvp,
      reusableCamPos,
      app.presentTarget,
      reusableLightDir,
      app.ambient,
      app.showBboxes,
      new Float32Array(inverseView),
      new Float32Array(inverseProjection),
      app.sunIlluminance,
      app.sunDiskScale,
      app.sunDiskSize,
      app.hazeDensity,
      app.fogDensity,
      app.fogFalloff,
      dt,
      app.sunOccSpeed,
    );
  };
  registerRecurringAnimation(render);

  initializeDevTools(app, profilerData);

  // Hide loading indicator
  document.getElementById('loading')?.classList.add('hidden');

  return app;
}

export const App = await initializeApp();
