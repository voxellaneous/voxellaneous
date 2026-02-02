import { Pane } from 'tweakpane';
import { AppData } from './main';
import { initializeRendererTools } from './renderer/editor';
import { ProfilerData } from './profiler-data';
import { initializeConverterUI } from './converter-ui';

export function initializeDevTools(app: AppData, profilerData: ProfilerData): void {
  const pane = new Pane();
  initializeRendererTools(pane, app, profilerData);
  initializeConverterUI(pane, app);
}
