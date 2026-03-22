import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  assetsInclude: ['**/*.wgsl'],
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});