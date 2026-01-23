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

export function initializeRendererTools(pane: Pane, app: AppData, profilerData: ProfilerData): void {
  const settingsFolder = pane.addFolder({ title: 'Renderer Settings' });
  settingsFolder.addBinding(app, 'presentTarget', {
    label: 'Render Target',
    options: [
      { text: 'Lit', value: 4 },
      { text: 'Albedo', value: 0 },
      { text: 'Normal', value: 1 },
      { text: 'Linear-Z', value: 2 },
      { text: 'Depth', value: 3 },
    ],
  });
  settingsFolder.addBinding(app, 'showBboxes', {
    label: 'Show Bounding Boxes',
  });

  const lightingFolder = pane.addFolder({ title: 'Lighting' });
  lightingFolder.addBinding(app, 'lightDir', {
    label: 'Light Direction',
    x: { min: -1, max: 1, step: 0.01 },
    y: { min: -1, max: 1, step: 0.01 },
    z: { min: -1, max: 1, step: 0.01 },
  });
  lightingFolder.addBinding(app, 'ambient', {
    label: 'Ambient',
    min: 0,
    max: 1,
    step: 0.01,
  });
  lightingFolder.addBinding(app, 'lightIntensity', {
    label: 'Light Intensity',
    min: 0,
    max: 3,
    step: 0.1,
  });

  const gpuData = app.renderer.get_gpu_info() as GPUData;

  const backendFolder = pane.addFolder({ title: 'Renderer Backend' });
  backendFolder.expanded = false;

  backendFolder.addBinding(gpuData, 'name', { label: 'Name', readonly: true });
  backendFolder.addBinding(gpuData, 'vendor', { label: 'Vendor', readonly: true, format: (v) => Math.floor(v) });
  backendFolder.addBinding(gpuData, 'device', { label: 'Device', readonly: true, format: (v) => Math.floor(v) });
  backendFolder.addBinding(gpuData, 'device_type', { label: 'Device Type', readonly: true });
  backendFolder.addBinding(gpuData, 'driver', { label: 'Driver', readonly: true });
  backendFolder.addBinding(gpuData, 'driver_info', { label: 'Driver Info', readonly: true });
  backendFolder.addBinding(gpuData, 'backend', { label: 'Backend', readonly: true });

  const performanceFolder = pane.addFolder({ title: 'Performance' });
  performanceFolder.addBinding(profilerData, 'fps', { label: 'FPS', readonly: true, format: (v) => v.toFixed(2) });
  performanceFolder.addBinding(profilerData, 'frameTime', {
    label: 'Frame Time (ms)',
    readonly: true,
    format: (v) => v.toFixed(2),
  });
}
