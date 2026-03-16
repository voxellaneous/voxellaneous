import { CameraModule } from './camera';
import './style.css';

import { Renderer } from './renderer';
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
  id: string,
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

function buildRemoteSignature(
  remotePlayers: Map<string, { id: string; position: { x: number; y: number; z: number } }>,
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

  const wsUrl = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:8080`;
  const roomId = import.meta.env.VITE_WS_ROOM || 'lobby';
  const network = new NetworkClient({ url: wsUrl, roomId });

  const renderer = await Renderer.new(canvas);
  const cameraModule = new CameraModule(canvas);
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0, 0, 1]));
  cameraModule.setPosition([3770, 300, 620]); // Above terrain level

  const app: AppData = {
    renderer,
    canvas,
    presentTarget: 4, // Default to Lit mode
    sunTime: 8,
    sunAngle: 260,
    ambient: 0.1,
    sunIlluminance: 10,
    sunDiskScale: 0.8,
    sunDiskSize: 2, // 0.545,
    showBboxes: false,
    cameraModule,
    cameraSpeed: cameraModule.speed,
    hazeDensity: 0.0004,
    fogDensity: 0,
    fogFalloff: 0.01,
    sunTimeScale: 0,
    sponzaPosition: { x: 3770, y: 755, z: 620 },
  };
  const profilerData: ProfilerData = { fps: 0, frameTime: 0, lastTimeStamp: 0 };

  const { autoresizeCanvas } = createCanvasAutoresize(app);

  // Load sponza scene
  let sponzaBaseObjects: VoxelObject[] = [];
  try {
    const response = await fetch('/resources/sponza.voxgz');
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
  // Uses DEFAULT_TERRAIN_CONFIG for noise layers and other defaults
  const terrainManager = new ChunkManager();
  app.terrainManager = terrainManager;

  const shadowClipmap = new ShadowClipmapManager(terrainManager.getChunkCache(), terrainManager.getConfig());

  const characterController = new CharacterController();
  characterController.setFromEyePosition(cameraModule.position);
  app.characterController = characterController;

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && !e.repeat) {
      characterController.toggleFlyWalk();
      if (!characterController.isFlying) {
        characterController.setFromEyePosition(cameraModule.position);
      }
    }
  });

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

  let lastRemoteSignature = '';
  const updateRemoteScene = () => {
    const remotePlayers = network.getRemotePlayers();
    const signature = buildRemoteSignature(remotePlayers);
    if (signature === lastRemoteSignature) return;
    lastRemoteSignature = signature;

    const remoteObjects = Array.from(remotePlayers.values()).map((player) =>
      createRemoteMarkerObject(player.id, player.position, markerVoxels),
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

  // NOW start render loop after scene is uploaded
  let lastFrameTime = 0;
  const render: FrameRequestCallback = (time) => {
    const dt = lastFrameTime === 0 ? 1 / 60 : Math.min((time - lastFrameTime) / 1000, 0.1);
    lastFrameTime = time;

    autoresizeCanvas();
    updateProfilerData(profilerData, time);

    cameraModule.updateLook();
    if (characterController.isFlying) {
      cameraModule.updateFlyMovement(dt);
    } else {
      const motion = cameraModule.getInputMotion();
      const jumpPressed = cameraModule.isKeyPressed('Space');
      const eyePos = characterController.update(dt, motion, jumpPressed, (x, z) => terrainManager.queryHeight(x, z));
      cameraModule.setPosition(eyePos);
    }

    network.setLocalState(
      { x: cameraModule.position[0], y: cameraModule.position[1], z: cameraModule.position[2] },
      { x: cameraModule.direction[0], y: cameraModule.direction[1], z: cameraModule.direction[2] },
    );

    // Update terrain chunks based on camera position
    const terrainChanged = app.terrainManager!.update(cameraModule.position);
    if (terrainChanged) {
      const heightmapChunks = app.terrainManager!.getVisibleHeightmapChunks();
      const remotePlayers = network.getRemotePlayers();
      const remoteObjects = Array.from(remotePlayers.values()).map((player) =>
        createRemoteMarkerObject(player.id, player.position, markerVoxels),
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
    // phase=0 at 6h (sunrise), PI/2 at noon (peak), PI at 18h (sunset)
    const tilt = (75 * Math.PI) / 180;
    const phase = ((app.sunTime - 6) / 24) * 2 * Math.PI;
    // Sun in orbit frame, then tilt around X axis
    const sx = Math.cos(phase);
    const sy = Math.sin(phase) * Math.sin(tilt);
    const sz = -Math.sin(phase) * Math.cos(tilt);
    // Rotate around Y by sunAngle to orient the orbit
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
    );
  };
  registerRecurringAnimation(render);

  initializeDevTools(app, profilerData);
  network.start();
  window.addEventListener('beforeunload', () => {
    network.stop();
  });

  // Hide loading indicator
  document.getElementById('loading')?.classList.add('hidden');

  return app;
}

export const App = await initializeApp();
