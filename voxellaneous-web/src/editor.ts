import { Pane } from 'tweakpane';
import { AppData } from './main';
import { initializeRendererTools } from './renderer/editor';
import { ProfilerData } from './profiler-data';
import { initializeConverterUI } from './converter-ui';
import { NoiseLayer } from './terrain/types';

export function initializeDevTools(app: AppData, profilerData: ProfilerData): void {
  const pane = new Pane();
  initializeRendererTools(pane, app, profilerData);
  initializeConverterUI(pane, app);
  initializeCameraControls(pane, app);
  initializeTerrainControls(pane, app);
}

function initializeCameraControls(pane: Pane, app: AppData): void {
  const folder = pane.addFolder({ title: 'Camera' });

  folder.addBinding(app, 'cameraSpeed', {
    label: 'Speed',
    min: 0.1,
    max: 10,
    step: 0.1,
  }).on('change', (ev) => {
    app.cameraModule?.setSpeed(ev.value);
  });
}

function initializeTerrainControls(pane: Pane, app: AppData): void {
  if (!app.terrainManager) return;

  const config = app.terrainManager.getConfig();
  const folder = pane.addFolder({ title: 'Terrain' });

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
  const noiseLayers: NoiseLayer[] = config.noiseLayers.map(layer => ({ ...layer }));

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
