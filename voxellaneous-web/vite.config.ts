import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/',
  assetsInclude: ['**/*.wgsl'],
  server: {
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
