/// <reference types="vite/client" />

// WGSL shader imports with ?raw suffix
declare module '*.wgsl?raw' {
  const content: string;
  export default content;
}
