import { Pane } from 'tweakpane';
import { AppData } from '../main';
import {
  convertGLTFFromFolder,
  exportToBinary,
  importFromBinary,
  createSceneFromResult,
  ConversionResult,
  VoxelizationConfig,
} from '../converter';

interface ConverterState {
  resolution: number;
  mode: 'surface' | 'solid';
  folderName: string;
  status: string;
  triangles: number;
  voxels: number;
  timeMs: number;
  quantized: boolean;
}

/**
 * Initializes the GLTF to Voxel converter UI in Tweakpane
 */
export function initializeConverterUI(pane: Pane, app: AppData): void {
  const folder = pane.addFolder({ title: 'GLTF Converter' });
  folder.expanded = false;

  const state: ConverterState = {
    resolution: 64,
    mode: 'surface',
    folderName: 'No folder selected',
    status: 'Ready',
    triangles: 0,
    voxels: 0,
    timeMs: 0,
    quantized: false,
  };

  let currentFiles: FileList | null = null;
  let currentFileName: string = '';
  let currentResult: ConversionResult | null = null;

  // Hidden folder input
  const folderInput = document.createElement('input');
  folderInput.type = 'file';
  folderInput.webkitdirectory = true;
  folderInput.style.display = 'none';
  document.body.appendChild(folderInput);

  // Folder selection
  folder.addButton({ title: 'Load Folder' }).on('click', () => {
    folderInput.click();
  });

  folderInput.addEventListener('change', () => {
    const files = folderInput.files;
    if (files && files.length > 0) {
      currentFiles = files;
      // Get folder name from first file's path
      const firstPath = files[0].webkitRelativePath;
      const folderName = firstPath.split('/')[0];
      state.folderName = folderName;

      // Find the GLTF/GLB file name
      for (let i = 0; i < files.length; i++) {
        if (files[i].name.endsWith('.gltf') || files[i].name.endsWith('.glb')) {
          currentFileName = files[i].name;
          break;
        }
      }

      state.status = `Loaded ${files.length} files`;
      pane.refresh();
    }
  });

  // Folder name display
  folder.addBinding(state, 'folderName', {
    label: 'Folder',
    readonly: true,
  });

  // Resolution slider
  folder.addBinding(state, 'resolution', {
    label: 'Resolution',
    min: 16,
    max: 1024,
    step: 16,
  });

  // Mode dropdown
  folder.addBinding(state, 'mode', {
    label: 'Mode',
    options: [
      { text: 'Surface', value: 'surface' },
      { text: 'Solid', value: 'solid' },
    ],
  });

  // Convert button
  folder.addButton({ title: 'Convert' }).on('click', async () => {
    if (!currentFiles) {
      state.status = 'No folder selected';
      pane.refresh();
      return;
    }

    state.status = 'Converting...';
    pane.refresh();

    try {
      const config: VoxelizationConfig = {
        resolution: state.resolution,
        mode: state.mode,
      };

      currentResult = await convertGLTFFromFolder(currentFiles, config);

      state.triangles = currentResult.stats.triangles;
      state.voxels = currentResult.stats.voxels;
      state.timeMs = Math.round(currentResult.stats.timeMs);
      state.quantized = currentResult.stats.quantized;
      state.status = 'Conversion complete';

      // Display in renderer
      const scene = createSceneFromResult(currentResult);
      app.renderer.upload_scene(scene);

      pane.refresh();
    } catch (error) {
      state.status = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      pane.refresh();
    }
  });

  // Status display
  folder.addBinding(state, 'status', {
    label: 'Status',
    readonly: true,
  });

  // Stats folder
  const statsFolder = folder.addFolder({ title: 'Stats' });
  statsFolder.expanded = false;

  statsFolder.addBinding(state, 'triangles', {
    label: 'Triangles',
    readonly: true,
    format: (v) => Math.floor(v).toLocaleString(),
  });

  statsFolder.addBinding(state, 'voxels', {
    label: 'Voxels',
    readonly: true,
    format: (v) => Math.floor(v).toLocaleString(),
  });

  statsFolder.addBinding(state, 'timeMs', {
    label: 'Time (ms)',
    readonly: true,
    format: (v) => Math.floor(v).toLocaleString(),
  });

  statsFolder.addBinding(state, 'quantized', {
    label: 'Quantized',
    readonly: true,
  });

  // Export Binary button
  folder.addButton({ title: 'Export Binary' }).on('click', async () => {
    if (!currentResult || !currentFileName) {
      state.status = 'Nothing to export';
      pane.refresh();
      return;
    }

    state.status = 'Exporting...';
    pane.refresh();

    try {
      const blob = await exportToBinary(currentResult);
      downloadFile(blob, currentFileName.replace(/\.[^.]+$/, '') + '.voxgz');
      state.status = 'Exported Binary';
      pane.refresh();
    } catch (error) {
      state.status = `Export error: ${error instanceof Error ? error.message : 'Unknown'}`;
      pane.refresh();
    }
  });

  // Hidden file input for binary import
  const binaryInput = document.createElement('input');
  binaryInput.type = 'file';
  binaryInput.accept = '.voxgz';
  binaryInput.style.display = 'none';
  document.body.appendChild(binaryInput);

  // Import Binary button
  folder.addButton({ title: 'Import Binary' }).on('click', () => {
    binaryInput.click();
  });

  binaryInput.addEventListener('change', async () => {
    const file = binaryInput.files?.[0];
    if (!file) return;

    state.status = 'Importing...';
    pane.refresh();

    try {
      currentResult = await importFromBinary(file);
      currentFileName = file.name;

      state.triangles = currentResult.stats.triangles;
      state.voxels = currentResult.stats.voxels;
      state.timeMs = 0;
      state.quantized = currentResult.stats.quantized;
      state.folderName = file.name;
      state.status = 'Import complete';

      // Display in renderer
      const scene = createSceneFromResult(currentResult);
      app.renderer.upload_scene(scene);

      pane.refresh();
    } catch (error) {
      state.status = `Import error: ${error instanceof Error ? error.message : 'Unknown'}`;
      pane.refresh();
    }

    // Reset input so same file can be selected again
    binaryInput.value = '';
  });
}

/**
 * Downloads a blob as a file
 */
function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
