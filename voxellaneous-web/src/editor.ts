import { Pane } from 'tweakpane';
import { AppData } from './main';
import { initializeRendererTools, initializeRendererBackendInfo } from './renderer/editor';
import { ProfilerData } from './profiler-data';
import { initializeConverterUI } from './converter-ui';
import { NoiseLayer } from './terrain/types';

export function initializeDevTools(app: AppData, profilerData: ProfilerData): void {
  const isMobile = window.matchMedia('(pointer: coarse)').matches;
  const pane = new Pane();

  if (isMobile) {
    const perfFolder = pane.addFolder({ title: 'Performance' });
    perfFolder.addBinding(profilerData, 'fps', { label: 'FPS', readonly: true, format: (v) => v.toFixed(0) });
    initializeRendererBackendInfo(pane, app);
    return;
  }

  initializeRendererTools(pane, app, profilerData);
  initializeConverterUI(pane, app);
  initializeCameraControls(pane, app);
  initializeTerrainControls(pane, app);
}

function initializeCameraControls(pane: Pane, app: AppData): void {
  if (app.cameraModule) {
    const folder = pane.addFolder({ title: 'Camera' });

    folder
      .addBinding(app, 'cameraSpeed', {
        label: 'Fly Speed',
        min: 10,
        max: 5000,
        step: 10,
      })
      .on('change', (ev) => {
        app.cameraModule?.setSpeed(ev.value);
      });

    if (app.characterController) {
      const cc = app.characterController;
      const physicsFolder = folder.addFolder({ title: 'Physics (F to toggle)', expanded: false });

      physicsFolder.addBinding(cc.config, 'walkSpeed', {
        label: 'Walk Speed',
        min: 32,
        max: 320,
        step: 16,
      });

      physicsFolder.addBinding(cc.config, 'gravity', {
        label: 'Gravity',
        min: -640,
        max: -32,
        step: 16,
      });

      physicsFolder.addBinding(cc.config, 'jumpVelocity', {
        label: 'Jump Force',
        min: 50,
        max: 400,
        step: 10,
      });

      physicsFolder.addBinding(cc.config, 'playerHeight', {
        label: 'Eye Height',
        min: 16,
        max: 96,
        step: 4,
      });
    }
  }
}

function initializeTerrainControls(pane: Pane, app: AppData): void {
  if (!app.terrainManager) return;

  const config = app.terrainManager.getConfig();
  const folder = pane.addFolder({ title: 'Terrain', expanded: false });

  const params = {
    seed: config.seed,
    heightScale: config.heightScale,
    baseTerrainHeight: config.baseTerrainHeight,
  };

  folder.addBinding(params, 'seed', {
    label: 'Seed',
    min: 0,
    max: 10000,
    step: 1,
  });

  folder.addBinding(params, 'heightScale', {
    label: 'Height',
    min: 64,
    max: 1024,
    step: 32,
  });

  folder.addBinding(params, 'baseTerrainHeight', {
    label: 'Base Level',
    min: -256,
    max: 512,
    step: 16,
  });

  // Create a deep copy of noise layers for editing
  const noiseLayers: NoiseLayer[] = config.noiseLayers.map((layer) => ({ ...layer }));

  // Add controls for each noise layer (Mountains, Hills, Details)
  for (let i = 0; i < noiseLayers.length; i++) {
    const layer = noiseLayers[i];
    const layerFolder = folder.addFolder({
      title: layer.name,
      expanded: false,
    });

    layerFolder.addBinding(layer, 'enabled', { label: 'Enabled' });

    layerFolder.addBinding(layer, 'frequency', {
      label: 'Frequency',
      min: 0.0001,
      max: 0.05,
      step: 0.0001,
    });

    layerFolder.addBinding(layer, 'amplitude', {
      label: 'Amplitude',
      min: 0,
      max: 100,
      step: 0.1,
    });
  }

  // Regenerate button
  folder.addButton({ title: 'Regenerate' }).on('click', () => {
    if (!app.terrainManager) return;

    app.terrainManager.reinitialize({
      ...config,
      seed: params.seed,
      heightScale: params.heightScale,
      baseTerrainHeight: params.baseTerrainHeight,
      noiseLayers: noiseLayers,
    });

    if (app.cameraModule) {
      app.terrainManager.update(app.cameraModule.position);
      app.renderer.uploadScene({
        palette: [],
        objects: [],
        heightmapObjects: app.terrainManager.getVisibleHeightmapChunks(),
      });
    }
  });
}
