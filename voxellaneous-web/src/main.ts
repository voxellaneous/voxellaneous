import { CameraModule } from './camera';
import './style.css';

import init, { Renderer } from 'voxellaneous-core';
import { initializeDevTools } from './editor';
import { importFromBinary, createSceneFromResult } from './converter';
import { Scene } from './scene';
import { ProfilerData, updateProfilerData } from './profiler-data';
import { vec3 } from 'gl-matrix';
import { NetworkClient } from './network';
import { mat4 } from 'gl-matrix';

const remoteMarkerSize = 4;

function createUniformVoxelData(size: number, paletteIndex: number): Uint8Array {
  const total = size * size * size;
  const voxels = new Uint8Array(total);
  voxels.fill(paletteIndex);
  return voxels;
}

function createRemoteMarkerObject(id: string, position: { x: number; y: number; z: number }, markerVoxels: Uint8Array) {
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, [position.x, position.y, position.z]);
  mat4.scale(modelMatrix, modelMatrix, [remoteMarkerSize, remoteMarkerSize, remoteMarkerSize]);
  const inverseModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  return {
    id: `remote_${id}`,
    dims: vec3.fromValues(remoteMarkerSize, remoteMarkerSize, remoteMarkerSize),
    model_matrix: modelMatrix,
    inv_model_matrix: inverseModelMatrix,
    voxels: markerVoxels,
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

  await init({});
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
  const profilerData: ProfilerData = { fps: 0, frameTime: 0, lastTimeStamp: 0 };

  const cameraModule = new CameraModule(canvas);
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0.5, 0, -1]));
  cameraModule.setPosition([-100, -470, -356]);

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
  renderer.upload_scene(baseScene);

  const markerVoxels = createUniformVoxelData(remoteMarkerSize, 0);

  let lastRemoteSignature = '';
  const updateRemoteScene = () => {
    const remotePlayers = network.getRemotePlayers();
    const signature = buildRemoteSignature(remotePlayers);
    if (signature === lastRemoteSignature) return;
    lastRemoteSignature = signature;

    const remoteObjects = Array.from(remotePlayers.values()).map((player) =>
      createRemoteMarkerObject(player.id, player.position, markerVoxels),
    );
    const scene: Scene = {
      palette: baseScene.palette,
      objects: [...baseScene.objects, ...remoteObjects],
    };
    renderer.upload_scene(scene);
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
  network.start();
  window.addEventListener('beforeunload', () => {
    network.stop();
  });

  // Hide loading indicator
  document.getElementById('loading')?.classList.add('hidden');

  return app;
}

export const App = await initializeApp();
