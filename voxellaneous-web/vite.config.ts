import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.wgsl'],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});