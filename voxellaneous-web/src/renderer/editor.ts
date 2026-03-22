import { Pane } from 'tweakpane';
import { AppData } from '../main';
import { ProfilerData } from '../profiler-data';

type GPUData = {
  name: string;
  vendor: number;
  device: number;
  device_type: string;
  driver: string;
  driver_info: string;
  backend: string;
};

export function initializeRendererBackendInfo(pane: Pane, app: AppData): void {
  const gpuData = app.renderer.get_gpu_info() as GPUData;
  const backendFolder = pane.addFolder({ title: 'Renderer Backend' });
  backendFolder.expanded = false;
  backendFolder.addBinding(gpuData, 'driver', { label: 'Driver', readonly: true });
  backendFolder.addBinding(gpuData, 'backend', { label: 'Backend', readonly: true });
}

export function initializeRendererTools(pane: Pane, app: AppData, profilerData: ProfilerData): void {
  const settingsFolder = pane.addFolder({ title: 'Renderer Settings' });
  settingsFolder.addBinding(app, 'presentTarget', {
    label: 'Render Target',
    options: [
      { text: 'Lit', value: 4 },
      { text: 'Albedo', value: 0 },
      { text: 'Normal', value: 1 },
      { text: 'Linear-Z', value: 2 },
      { text: 'Shadow', value: 3 },
    ],
  });
  settingsFolder.addBinding(app, 'showBboxes', {
    label: 'Show Bounding Boxes',
  });

  const sunFolder = pane.addFolder({ title: 'Sun' });
  sunFolder.addBinding(app, 'sunTime', {
    label: 'Time of Day',
    min: 0,
    max: 24,
    step: 0.01,
  });
  sunFolder.addBinding(app, 'sunTimeScale', {
    label: 'Time Speed',
    min: 0,
    max: 100,
    step: 0.1,
  });
  sunFolder.addBinding(app, 'sunAngle', {
    label: 'Azimuth (°)',
    min: 0,
    max: 360,
    step: 1,
  });
  sunFolder.addBinding(app, 'sunIlluminance', {
    label: 'Illuminance',
    min: 0.1,
    max: 50,
    step: 0.5,
  });
  sunFolder.addBinding(app, 'sunDiskScale', {
    label: 'Disk Brightness',
    min: 0,
    max: 10,
    step: 0.1,
  });
  sunFolder.addBinding(app, 'sunDiskSize', {
    label: 'Disk Size (°)',
    min: 0.1,
    max: 5,
    step: 0.05,
  });

  sunFolder.addBinding(app, 'sunOccSpeed', {
    label: 'Occ. Speed',
    min: 0.1,
    max: 10.0,
    step: 0.1,
  });

  sunFolder.addBinding(app, 'ambient', {
    label: 'Ambient',
    min: 0,
    max: 1,
    step: 0.01,
  });

  const hazeFolder = pane.addFolder({ title: 'Atmospheric Haze' });
  hazeFolder.addBinding(app, 'hazeDensity', {
    label: 'Density',
    min: 0,
    max: 0.0005,
    step: 0.000005,
  });

  const fogFolder = pane.addFolder({ title: 'Ground Fog' });
  fogFolder.addBinding(app, 'fogDensity', {
    label: 'Density',
    min: 0,
    max: 0.1,
    step: 0.001,
  });
  fogFolder.addBinding(app, 'fogFalloff', {
    label: 'Height Falloff',
    min: 0.0,
    max: 0.1,
    step: 0.001,
  });

  initializeRendererBackendInfo(pane, app);

  const performanceFolder = pane.addFolder({ title: 'Performance' });
  performanceFolder.addBinding(profilerData, 'fps', { label: 'FPS', readonly: true, format: (v) => v.toFixed(2) });
  performanceFolder.addBinding(profilerData, 'frameTime', {
    label: 'Frame Time (ms)',
    readonly: true,
    format: (v) => v.toFixed(2),
  });
}
