import { defineConfig } from 'vite';

export default defineConfig({
  base: '/voxellaneous/',
  assetsInclude: ['**/*.wgsl'],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});