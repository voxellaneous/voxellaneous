import { CameraModule } from './camera';
import './style.css';

import { Renderer } from './renderer';
import { isMobileDevice, MOBILE_QUALITY, DESKTOP_QUALITY } from './renderer/types';
import { initializeDevTools } from './editor';
import { importFromBinary, createSceneFromResult, ConversionResult } from './converter';
import { VoxelObject, RGBA } from './scene';
import { ProfilerData, updateProfilerData } from './profiler-data';
import { vec3 } from 'gl-matrix';
import { NetworkClient } from './network';
import { mat4 } from 'gl-matrix';
import { ChunkManager, ShadowClipmapManager } from './terrain';
import { CharacterController } from './character-controller';
import { TouchInput } from './touch-input';

const reusableMvp = new Float32Array(16);
const reusableCamPos = new Float32Array(3);
const reusableLightDir = new Float32Array(3);

function playerColorFromId(id: number): RGBA {
  // Golden ratio spread for well-distributed hues
  const hue = (id * 137.508) % 360;
  const s = 0.7,
    l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255];
}

function tintPalette(palette: RGBA[], tint: RGBA): RGBA[] {
  return palette.map((c) => {
    if (c[3] === 0) return c;
    // Luminance of original color to preserve shading
    const lum = (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
    return [Math.round(tint[0] * lum), Math.round(tint[1] * lum), Math.round(tint[2] * lum), c[3]];
  });
}

function createRemotePlayerObject(
  id: number,
  position: { x: number; y: number; z: number },
  rotation: { y: number; w: number },
  playerModel: VoxelObject,
  playerHeight: number,
): VoxelObject {
  const [nx, ny, nz] = playerModel.dims;
  const yaw = 2 * Math.atan2(rotation.y, rotation.w);
  const modelMatrix = mat4.create();
  mat4.translate(modelMatrix, modelMatrix, [position.x, position.y - playerHeight, position.z]);
  mat4.rotateY(modelMatrix, modelMatrix, yaw - Math.PI / 2);
  mat4.scale(modelMatrix, modelMatrix, [nx, ny, nz]);
  mat4.translate(modelMatrix, modelMatrix, [0, 0.5, 0]);
  const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

  return {
    ...playerModel,
    id: `remote_${id}`,
    modelMatrix,
    invModelMatrix,
    palette: tintPalette(playerModel.palette, playerColorFromId(id)),
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
  addConvertedObject?: (result: ConversionResult) => void;
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
  (window as any).__network = network;

  const quality = isMobileDevice() ? MOBILE_QUALITY : DESKTOP_QUALITY;
  const renderer = await Renderer.new(canvas, quality);
  const cameraModule = new CameraModule(canvas);
  cameraModule.setDirection(vec3.normalize(vec3.create(), [0, 0, 1]));

  network.onSpawn((pos) => {
    cameraModule.setPosition([pos.x, pos.y, pos.z] as vec3);
    characterController.setFromEyePosition(cameraModule.position);

    // Set player name (skip for bots)
    if (!new URLSearchParams(window.location.search).has('bot')) {
      const saved = localStorage.getItem('playerName');
      const name = saved || prompt('Enter your name:') || 'Player';
      localStorage.setItem('playerName', name);
      network.setName(name);
    }
  });

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

  // Load player model for remote player rendering
  let playerModel: VoxelObject | null = null;
  try {
    const response = await fetch('/resources/player.voxgz');
    if (response.ok) {
      const compressed = new (await import('./common/types')).ByteArray(await response.arrayBuffer());
      const result = await (await import('./converter')).importFromArrayBuffer(compressed, 'player.voxgz');
      playerModel = { ...result.object, palette: result.palette };
    }
  } catch (e) {
    console.warn('Failed to load player model:', e);
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
  const convertedObjects: VoxelObject[] = [];

  function reuploadStaticObjects() {
    renderer.uploadStaticObjects([...offsetSponza(sponzaBaseObjects, app.sponzaPosition), ...convertedObjects], []);
  }

  reuploadStaticObjects();
  app.repositionSponza = reuploadStaticObjects;

  app.addConvertedObject = (result: ConversionResult) => {
    const obj = result.object;
    const [nx, ny, nz] = obj.dims;

    // Find the lowest occupied Y layer in the voxel data
    let minOccupiedY = ny;
    for (let y = 0; y < ny && minOccupiedY === ny; y++) {
      for (let z = 0; z < nz; z++) {
        for (let x = 0; x < nx; x++) {
          if (obj.voxels[x + y * nx + z * nx * ny] !== 0) {
            minOccupiedY = y;
            break;
          }
        }
        if (minOccupiedY !== ny) break;
      }
    }

    // Place ahead of the player in the facing direction (projected onto XZ plane)
    const [dx, , dz] = cameraModule.direction;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const footprint = Math.max(nx, nz);
    const spawnDist = footprint * 1.5;
    const spawnX = cameraModule.position[0] + (dx / len) * spawnDist;
    const spawnZ = cameraModule.position[2] + (dz / len) * spawnDist;

    // Sample terrain height at footprint corners and center, use the max so model never clips into slopes
    const halfFootprint = footprint / 2;
    let groundY = cameraModule.position[1];
    for (const [ox, oz] of [
      [0, 0],
      [-halfFootprint, -halfFootprint],
      [halfFootprint, -halfFootprint],
      [-halfFootprint, halfFootprint],
      [halfFootprint, halfFootprint],
    ]) {
      const h = terrainManager.queryHeight(spawnX + ox, spawnZ + oz);
      if (h !== null && h > groundY) groundY = h;
    }

    // Place so the lowest occupied voxel layer sits at ground level
    // Scale per-axis so each voxel is 1 cubic world unit
    const modelMatrix = mat4.create();
    mat4.translate(modelMatrix, modelMatrix, [spawnX, groundY, spawnZ]);
    mat4.scale(modelMatrix, modelMatrix, [nx, ny, nz]);
    mat4.translate(modelMatrix, modelMatrix, [-0.5, -minOccupiedY / ny, -0.5]);
    const invModelMatrix = mat4.invert(mat4.create(), modelMatrix)!;

    const positioned: VoxelObject = {
      ...obj,
      id: `converted_${obj.id}_${Date.now()}`,
      modelMatrix,
      invModelMatrix,
      palette: result.palette,
    };

    convertedObjects.push(positioned);
    reuploadStaticObjects();
  };

  // Initial terrain load (dynamic)
  terrainManager.update(cameraModule.position);
  renderer.uploadScene({
    palette: [],
    objects: [],
    heightmapObjects: terrainManager.getVisibleHeightmapChunks(),
  });

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

    // Combine keyboard + touch joystick motion
    const kbMotion = cameraModule.getInputMotion();
    if (touchInput) {
      const joy = touchInput.getJoystickVector();
      if (joy.forward !== 0 || joy.right !== 0) {
        const [fx, , fz] = cameraModule.direction;
        const [rx, , rz] = cameraModule.right;
        kbMotion[0] += fx * joy.forward + rx * joy.right;
        kbMotion[2] += fz * joy.forward + rz * joy.right;
        if (characterController.isFlying) {
          kbMotion[1] += cameraModule.direction[1] * joy.forward;
        }
        const len = vec3.length(kbMotion);
        if (len > 1) vec3.scale(kbMotion, kbMotion, 1 / len);
      }
    }

    // Client-side physics (gravity, ground collision, fly/walk)
    if (characterController.isFlying) {
      if (vec3.length(kbMotion) > 0) {
        vec3.scale(kbMotion, kbMotion, cameraModule.speed * dt);
        vec3.add(cameraModule.position, cameraModule.position, kbMotion);
      }
    } else {
      const jumpPressed = cameraModule.isKeyPressed('Space') || (touchInput?.jumpPressed ?? false);
      const eyePos = characterController.update(dt, kbMotion, jumpPressed, (x, z) => terrainManager.queryHeight(x, z));
      cameraModule.setPosition(eyePos);
    }

    // Send position + yaw to server
    const [cx, cy, cz] = cameraModule.position;
    const [dx, , dz] = cameraModule.direction;
    network.sendPosition(cx, cy, cz, Math.atan2(dx, dz));

    // Update remote players + terrain every frame for smooth interpolation
    const remoteEntities = network.getRemoteEntities();
    const { playerHeight } = characterController.config;
    const remoteObjects = playerModel
      ? remoteEntities.map((entity) =>
          createRemotePlayerObject(entity.id, entity.position, entity.rotation, playerModel, playerHeight),
        )
      : [];
    const heightmapChunks = app.terrainManager!.getVisibleHeightmapChunks();
    app.terrainManager!.update(cameraModule.position);
    renderer.uploadScene({
      palette: [],
      objects: remoteObjects,
      heightmapObjects: heightmapChunks,
    });

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

  if (!new URLSearchParams(window.location.search).has('bot')) {
    initializeDevTools(app, profilerData);
  }

  // -- Chat ---------------------------------------------------------------
  const chatLog = document.createElement('div');
  Object.assign(chatLog.style, {
    position: 'fixed', bottom: '48px', left: '12px',
    maxWidth: '400px', maxHeight: '200px', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: '2px',
    pointerEvents: 'auto', zIndex: '10',
  });
  document.body.appendChild(chatLog);

  const chatInput = document.createElement('input');
  Object.assign(chatInput.style, {
    position: 'fixed', bottom: '12px', left: '12px',
    width: '380px', padding: '6px 10px',
    background: 'rgba(0,0,0,0.6)', color: '#fff',
    border: '1px solid rgba(255,255,255,0.2)', borderRadius: '4px',
    fontFamily: 'monospace', fontSize: '13px',
    display: 'none', zIndex: '10', outline: 'none',
  });
  chatInput.placeholder = 'Type a message...';
  document.body.appendChild(chatInput);

  function addChatMessage(playerId: number, name: string, text: string) {
    const el = document.createElement('div');
    Object.assign(el.style, {
      background: 'rgba(0,0,0,0.5)', color: '#fff',
      padding: '3px 8px', borderRadius: '3px',
      fontFamily: 'monospace', fontSize: '13px',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    });
    const color = playerColorFromId(playerId);
    const label = name || `#${playerId}`;
    el.innerHTML = `<span style="color:rgb(${color[0]},${color[1]},${color[2]})">${label.replace(/</g, '&lt;')}</span> ${text.replace(/</g, '&lt;')}`;
    chatLog.appendChild(el);
    while (chatLog.children.length > 50) chatLog.removeChild(chatLog.firstChild!);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  network.onChat((msg) => addChatMessage(msg.playerId, msg.name, msg.text));

  // Press Enter to open chat, Enter to send, Escape to cancel
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && chatInput.style.display === 'none') {
      chatInput.style.display = 'block';
      chatInput.focus();
      chatInput.value = '';
      e.preventDefault();
    }
  });

  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't trigger game controls
    if (e.code === 'Enter') {
      const text = chatInput.value.trim();
      if (text) network.sendChat(text);
      chatInput.style.display = 'none';
      chatInput.blur();
    } else if (e.code === 'Escape') {
      chatInput.style.display = 'none';
      chatInput.blur();
    }
  });

  // Expose for MCP bot
  (window as any).__sendChat = (text: string) => network.sendChat(text);
  (window as any).__setName = (name: string) => network.setName(name);
  (window as any).__onChat = (cb: (msg: { playerId: number; name: string; text: string }) => void) => network.onChat(cb);

  // Hide loading indicator
  document.getElementById('loading')?.classList.add('hidden');

  return app;
}

export const App = await initializeApp();

// Expose for external control (MCP bot eye, dev tools)
(window as any).__game = App;
