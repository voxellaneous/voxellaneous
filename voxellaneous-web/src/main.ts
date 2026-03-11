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
import { ChunkManager } from './terrain';

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
  lightDir: { x: number; y: number; z: number };
  ambient: number;
  lightIntensity: number;
  showBboxes: boolean;
  terrainManager?: ChunkManager;
  cameraModule?: CameraModule;
  cameraSpeed: number;
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
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0.5, 0, -1]));
  cameraModule.setPosition([-100, 80, -356]); // Above terrain level

  const app: AppData = {
    renderer,
    canvas,
    presentTarget: 4, // Default to Lit mode
    lightDir: { x: 0.3, y: 0.55, z: 0.77 },
    ambient: 0.3,
    lightIntensity: 1.0,
    showBboxes: false,
    cameraModule,
    cameraSpeed: cameraModule.speed,
  };
  const profilerData: ProfilerData = { fps: 0, frameTime: 0, lastTimeStamp: 0 };

  const { autoresizeCanvas } = createCanvasAutoresize(app);

  // Load sponza scene
  let sponzaObjects: VoxelObject[] = [];
  try {
    const response = await fetch('/resources/sponza.voxgz');
    if (response.ok) {
      const blob = await response.blob();
      const file = new File([blob], 'sponza.voxgz');
      const result = await importFromBinary(file);
      const sponzaScene = createSceneFromResult(result);
      // Attach sponza palette and offset Y position
      const sponzaYOffset = 510; // Move sponza down to terrain level
      sponzaObjects = sponzaScene.objects.map((obj) => {
        const offsetMatrix = mat4.clone(obj.modelMatrix);
        offsetMatrix[13] += sponzaYOffset; // Add to Y translation
        const invOffsetMatrix = mat4.invert(mat4.create(), offsetMatrix)!;
        return {
          ...obj,
          modelMatrix: offsetMatrix,
          invModelMatrix: invOffsetMatrix,
          palette: sponzaScene.palette,
        };
      });
    }
  } catch (e) {
    console.warn('Failed to load sponza:', e);
  }

  // Initialize terrain manager with LOD levels
  // Uses DEFAULT_TERRAIN_CONFIG for noise layers and other defaults
  const terrainManager = new ChunkManager();
  app.terrainManager = terrainManager;

  // Debug: press F9 to dump stuck chunk info to console
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F9') terrainManager.debugStuckChunks();
    if (e.key === 'F10') terrainManager.toggleGapDetect();
  });

  // Upload sponza once as static objects
  renderer.uploadStaticObjects(sponzaObjects, []);

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
  const render: FrameRequestCallback = (time) => {
    autoresizeCanvas();
    updateProfilerData(profilerData, time);

    cameraModule.update();
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

    const mvpMatrix = cameraModule.calculateMVP();
    reusableMvp.set(mvpMatrix);
    reusableCamPos.set(cameraModule.position);
    reusableLightDir[0] = app.lightDir.x;
    reusableLightDir[1] = app.lightDir.y;
    reusableLightDir[2] = app.lightDir.z;

    renderer.render(
      reusableMvp,
      reusableCamPos,
      app.presentTarget,
      reusableLightDir,
      app.ambient,
      app.lightIntensity,
      app.showBboxes,
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
