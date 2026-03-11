/**
 * WebGPU Voxel Renderer
 * Ported from Rust/wgpu to TypeScript/WebGPU
 */

import { DrawCallData, Scene, UNIFORM_SIZES, RGBA, SceneObject as VoxelObject } from './types';
import type { HeightmapObject } from '../scene';
import { CUBE_VERTICES, CUBE_INDICES, CUBE_EDGE_INDICES, VERTEX_STRIDE } from './constants';
import { packRGBATuple } from './utils';
import { SkyAtmosphereRasterRenderer, makeEarthAtmosphere } from 'webgpu-sky-atmosphere';
import type { Uniforms as SkyUniforms } from 'webgpu-sky-atmosphere';

// Import shaders as raw strings
import shaderWgsl from './shaders/shader.wgsl?raw';
import heightmapWgsl from './shaders/heightmap.wgsl?raw';
import quadLightingWgsl from './shaders/quad_lighting.wgsl?raw';
import quadFloatWgsl from './shaders/quad_float.wgsl?raw';
import quadUintWgsl from './shaders/quad_uint.wgsl?raw';
import wireframeWgsl from './shaders/wireframe.wgsl?raw';
import tonemapWgsl from './shaders/tonemap.wgsl?raw';

interface AdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export class Renderer {
  private device: GPUDevice;
  private queue: GPUQueue;
  private adapterInfo: AdapterInfo;
  private context: GPUCanvasContext;
  private surfaceFormat: GPUTextureFormat;

  // Pipelines
  private renderPipeline: GPURenderPipeline;
  private quadPipelineUint: GPURenderPipeline;
  private quadPipelineFloat: GPURenderPipeline;
  private lightingPipeline: GPURenderPipeline;
  private wireframePipeline: GPURenderPipeline;

  // Bind group layouts
  private perFrameBindGroupLayout: GPUBindGroupLayout;
  private perDrawBindGroupLayout: GPUBindGroupLayout;
  private quadLayoutUint: GPUBindGroupLayout;
  private quadLayoutFloat: GPUBindGroupLayout;
  private lightingLayout: GPUBindGroupLayout;
  private wireframeBindGroupLayout: GPUBindGroupLayout;

  // Buffers
  private vertexBuffer: GPUBuffer;
  private indexBuffer: GPUBuffer;
  private edgeIndexBuffer: GPUBuffer;
  private perFrameUniformBuffer: GPUBuffer;
  private lightingUniformBuffer: GPUBuffer;

  // Textures
  private gbufferAlbedoTexture: GPUTexture;
  private gbufferAlbedo: GPUTextureView;
  private gbufferNormalTexture: GPUTexture;
  private gbufferNormal: GPUTextureView;
  private gbufferLinearZTexture: GPUTexture;
  private gbufferLinearZ: GPUTextureView;
  private depthTexture: GPUTexture;
  private depthTextureView: GPUTextureView;
  private sampler: GPUSampler;

  // Draw call data
  private staticDrawCalls: DrawCallData[] = [];
  private dynamicDrawCalls: DrawCallData[] = [];
  private dynamicDrawCallCache: Map<string, DrawCallData> = new Map();

  // Pre-allocated per-frame buffers
  private perFrameData = new ArrayBuffer(UNIFORM_SIZES.PER_FRAME);
  private perFrameView = new DataView(this.perFrameData);
  private lightingData = new ArrayBuffer(UNIFORM_SIZES.LIGHTING);
  private lightingView = new DataView(this.lightingData);

  // Heightmap pipeline and draw calls
  private heightmapPipeline!: GPURenderPipeline;
  private heightmapPerDrawBindGroupLayout!: GPUBindGroupLayout;
  private heightmapDrawCalls: DrawCallData[] = [];
  private heightmapDrawCallCache: Map<string, DrawCallData> = new Map();

  // Sky atmosphere
  private skyRenderer!: SkyAtmosphereRasterRenderer;
  private depthOnlyView!: GPUTextureView;

  // HDR + tone mapping
  private hdrTexture!: GPUTexture;
  private hdrView!: GPUTextureView;
  private toneMapPipeline!: GPURenderPipeline;
  private toneMapLayout!: GPUBindGroupLayout;

  private constructor(
    device: GPUDevice,
    queue: GPUQueue,
    adapterInfo: AdapterInfo,
    context: GPUCanvasContext,
    surfaceFormat: GPUTextureFormat,
    renderPipeline: GPURenderPipeline,
    quadPipelineUint: GPURenderPipeline,
    quadPipelineFloat: GPURenderPipeline,
    lightingPipeline: GPURenderPipeline,
    wireframePipeline: GPURenderPipeline,
    perFrameBindGroupLayout: GPUBindGroupLayout,
    perDrawBindGroupLayout: GPUBindGroupLayout,
    quadLayoutUint: GPUBindGroupLayout,
    quadLayoutFloat: GPUBindGroupLayout,
    lightingLayout: GPUBindGroupLayout,
    wireframeBindGroupLayout: GPUBindGroupLayout,
    vertexBuffer: GPUBuffer,
    indexBuffer: GPUBuffer,
    edgeIndexBuffer: GPUBuffer,
    perFrameUniformBuffer: GPUBuffer,
    lightingUniformBuffer: GPUBuffer,
    gbufferAlbedoTexture: GPUTexture,
    gbufferAlbedo: GPUTextureView,
    gbufferNormalTexture: GPUTexture,
    gbufferNormal: GPUTextureView,
    gbufferLinearZTexture: GPUTexture,
    gbufferLinearZ: GPUTextureView,
    depthTexture: GPUTexture,
    depthTextureView: GPUTextureView,
    sampler: GPUSampler,
  ) {
    this.device = device;
    this.queue = queue;
    this.adapterInfo = adapterInfo;
    this.context = context;
    this.surfaceFormat = surfaceFormat;
    this.renderPipeline = renderPipeline;
    this.quadPipelineUint = quadPipelineUint;
    this.quadPipelineFloat = quadPipelineFloat;
    this.lightingPipeline = lightingPipeline;
    this.wireframePipeline = wireframePipeline;
    this.perFrameBindGroupLayout = perFrameBindGroupLayout;
    this.perDrawBindGroupLayout = perDrawBindGroupLayout;
    this.quadLayoutUint = quadLayoutUint;
    this.quadLayoutFloat = quadLayoutFloat;
    this.lightingLayout = lightingLayout;
    this.wireframeBindGroupLayout = wireframeBindGroupLayout;
    this.vertexBuffer = vertexBuffer;
    this.indexBuffer = indexBuffer;
    this.edgeIndexBuffer = edgeIndexBuffer;
    this.perFrameUniformBuffer = perFrameUniformBuffer;
    this.lightingUniformBuffer = lightingUniformBuffer;
    this.gbufferAlbedoTexture = gbufferAlbedoTexture;
    this.gbufferAlbedo = gbufferAlbedo;
    this.gbufferNormalTexture = gbufferNormalTexture;
    this.gbufferNormal = gbufferNormal;
    this.gbufferLinearZTexture = gbufferLinearZTexture;
    this.gbufferLinearZ = gbufferLinearZ;
    this.depthTexture = depthTexture;
    this.depthTextureView = depthTextureView;
    this.sampler = sampler;
  }

  static async new(canvas: HTMLCanvasElement): Promise<Renderer> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser');
    }

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      throw new Error('Failed to get WebGPU adapter');
    }

    // Get adapter info - use the info property if available
    const adapterInfo: AdapterInfo = {
      vendor: adapter.info?.vendor ?? 'unknown',
      architecture: adapter.info?.architecture ?? 'unknown',
      device: adapter.info?.device ?? 'unknown',
      description: adapter.info?.description ?? 'unknown',
    };

    const device = await adapter.requestDevice({
      requiredFeatures: [],
    });
    const queue = device.queue;

    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get WebGPU context');
    }

    const surfaceFormat = navigator.gpu.getPreferredCanvasFormat();
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    context.configure({
      device,
      format: surfaceFormat,
      alphaMode: 'opaque',
    });

    const sampler = device.createSampler({});

    // Create depth texture
    const {
      texture: depthTexture,
      view: depthTextureView,
      depthOnlyView,
    } = createDepthTexture(device, canvasWidth, canvasHeight);

    // Create shader modules
    const shader = device.createShaderModule({
      label: 'Shader',
      code: shaderWgsl,
    });

    // Create vertex buffer
    const vertexBuffer = device.createBuffer({
      label: 'Vertex Buffer',
      size: CUBE_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(vertexBuffer, 0, CUBE_VERTICES);

    // Create index buffer
    const indexBuffer = device.createBuffer({
      label: 'Index Buffer',
      size: CUBE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(indexBuffer, 0, CUBE_INDICES);

    // Create edge index buffer for wireframe
    const edgeIndexBuffer = device.createBuffer({
      label: 'Edge Index Buffer',
      size: CUBE_EDGE_INDICES.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    queue.writeBuffer(edgeIndexBuffer, 0, CUBE_EDGE_INDICES);

    // Create uniform buffers
    const perFrameUniformBuffer = device.createBuffer({
      label: 'Per Frame Uniform Buffer',
      size: UNIFORM_SIZES.PER_FRAME,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const lightingUniformBuffer = device.createBuffer({
      label: 'Lighting Uniform Buffer',
      size: UNIFORM_SIZES.LIGHTING,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group layouts
    const perFrameBindGroupLayout = device.createBindGroupLayout({
      label: 'Per Frame Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const perDrawBindGroupLayout = device.createBindGroupLayout({
      label: 'Per Draw Call Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'uint',
            viewDimension: '3d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    // Create main render pipeline (no static bind group - palette is in per-draw)
    const pipelineLayout = device.createPipelineLayout({
      label: 'Pipeline Layout',
      bindGroupLayouts: [perFrameBindGroupLayout, perDrawBindGroupLayout],
    });

    const renderPipeline = device.createRenderPipeline({
      label: 'G-Buffer Render Pipeline',
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            stepMode: 'vertex',
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [
          { format: 'rgba8unorm' }, // albedo
          { format: 'rgba8unorm' }, // normal
          { format: 'r16uint' }, // linearZ
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'greater', // Reverse-Z: near=1, far=0
      },
    });

    // Create G-buffer textures
    const { texture: gbufferAlbedoTexture, view: gbufferAlbedo } = createRenderTexture(
      device,
      canvasWidth,
      canvasHeight,
      'rgba8unorm',
      'GBuffer Albedo',
    );
    const { texture: gbufferNormalTexture, view: gbufferNormal } = createRenderTexture(
      device,
      canvasWidth,
      canvasHeight,
      'rgba8unorm',
      'GBuffer Normal',
    );
    const { texture: gbufferLinearZTexture, view: gbufferLinearZ } = createRenderTexture(
      device,
      canvasWidth,
      canvasHeight,
      'r16uint',
      'GBuffer LinearZ',
    );

    // Create quad pipelines
    const { layout: quadLayoutUint, pipeline: quadPipelineUint } = createFullscreenQuadPipeline(
      device,
      surfaceFormat,
      quadUintWgsl,
      'uint',
      'non-filtering',
      'Quad Layout Uint',
      'Quad Uint Shader',
      'Quad Pipeline Uint',
    );

    const { layout: quadLayoutFloat, pipeline: quadPipelineFloat } = createFullscreenQuadPipeline(
      device,
      surfaceFormat,
      quadFloatWgsl,
      'unfilterable-float',
      'filtering',
      'Quad Layout Float',
      'Quad Float Shader',
      'Quad Pipeline Float',
    );

    // Create lighting pipeline
    const lightingLayout = device.createBindGroupLayout({
      label: 'Lighting Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
          },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'depth',
            viewDimension: '2d',
          },
        },
      ],
    });

    const lightingShader = device.createShaderModule({
      label: 'Lighting Shader',
      code: quadLightingWgsl,
    });

    const lightingPipelineLayout = device.createPipelineLayout({
      label: 'Lighting Pipeline Layout',
      bindGroupLayouts: [lightingLayout],
    });

    const hdrFormat: GPUTextureFormat = 'rgba16float';

    const lightingPipeline = device.createRenderPipeline({
      label: 'Lighting Pipeline',
      layout: lightingPipelineLayout,
      vertex: {
        module: lightingShader,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: lightingShader,
        entryPoint: 'fs_main',
        targets: [{ format: hdrFormat }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    // Create wireframe pipeline
    const wireframeBindGroupLayout = device.createBindGroupLayout({
      label: 'Wireframe Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const wireframeShader = device.createShaderModule({
      label: 'Wireframe Shader',
      code: wireframeWgsl,
    });

    const wireframePipelineLayout = device.createPipelineLayout({
      label: 'Wireframe Pipeline Layout',
      bindGroupLayouts: [perFrameBindGroupLayout, wireframeBindGroupLayout],
    });

    const wireframePipeline = device.createRenderPipeline({
      label: 'Wireframe Pipeline',
      layout: wireframePipelineLayout,
      vertex: {
        module: wireframeShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            stepMode: 'vertex',
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
            ],
          },
        ],
      },
      fragment: {
        module: wireframeShader,
        entryPoint: 'fs_main',
        targets: [
          {
            format: surfaceFormat,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: {
        topology: 'line-list',
      },
    });

    // Create heightmap pipeline (2D texture instead of 3D)
    const heightmapPerDrawBindGroupLayout = device.createBindGroupLayout({
      label: 'Heightmap Per Draw Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'uint',
            viewDimension: '2d',
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const heightmapShader = device.createShaderModule({
      label: 'Heightmap Shader',
      code: heightmapWgsl,
    });

    const heightmapPipelineLayout = device.createPipelineLayout({
      label: 'Heightmap Pipeline Layout',
      bindGroupLayouts: [perFrameBindGroupLayout, heightmapPerDrawBindGroupLayout],
    });

    const heightmapPipeline = device.createRenderPipeline({
      label: 'Heightmap G-Buffer Pipeline',
      layout: heightmapPipelineLayout,
      vertex: {
        module: heightmapShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE,
            stepMode: 'vertex',
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
            ],
          },
        ],
      },
      fragment: {
        module: heightmapShader,
        entryPoint: 'fs_main',
        targets: [
          { format: 'rgba8unorm' }, // albedo
          { format: 'rgba8unorm' }, // normal
          { format: 'r16uint' }, // linearZ
        ],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'greater', // Reverse-Z
      },
    });

    const renderer = new Renderer(
      device,
      queue,
      adapterInfo,
      context,
      surfaceFormat,
      renderPipeline,
      quadPipelineUint,
      quadPipelineFloat,
      lightingPipeline,
      wireframePipeline,
      perFrameBindGroupLayout,
      perDrawBindGroupLayout,
      quadLayoutUint,
      quadLayoutFloat,
      lightingLayout,
      wireframeBindGroupLayout,
      vertexBuffer,
      indexBuffer,
      edgeIndexBuffer,
      perFrameUniformBuffer,
      lightingUniformBuffer,
      gbufferAlbedoTexture,
      gbufferAlbedo,
      gbufferNormalTexture,
      gbufferNormal,
      gbufferLinearZTexture,
      gbufferLinearZ,
      depthTexture,
      depthTextureView,
      sampler,
    );

    renderer.heightmapPipeline = heightmapPipeline;
    renderer.heightmapPerDrawBindGroupLayout = heightmapPerDrawBindGroupLayout;

    renderer.depthOnlyView = depthOnlyView;
    renderer.skyRenderer = SkyAtmosphereRasterRenderer.create(device, {
      atmosphere: makeEarthAtmosphere(undefined, true),
      fromKilometersScale: 2000,
      initializeConstantLuts: true,
      skyRenderer: {
        renderTargetFormat: hdrFormat,
        depthBuffer: {
          texture: depthTexture,
          view: depthOnlyView,
          reverseZ: true,
        },
      },
    });

    // HDR intermediate texture
    const { texture: hdrTexture, view: hdrView } = createRenderTexture(
      device,
      canvasWidth,
      canvasHeight,
      hdrFormat,
      'HDR Buffer',
    );
    renderer.hdrTexture = hdrTexture;
    renderer.hdrView = hdrView;

    // Tone mapping pipeline
    const toneMapLayout = device.createBindGroupLayout({
      label: 'Tone Map Layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const toneMapShader = device.createShaderModule({ label: 'Tone Map Shader', code: tonemapWgsl });
    const toneMapPipeline = device.createRenderPipeline({
      label: 'Tone Map Pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [toneMapLayout] }),
      vertex: { module: toneMapShader, entryPoint: 'vs_main' },
      fragment: { module: toneMapShader, entryPoint: 'fs_main', targets: [{ format: surfaceFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    renderer.toneMapPipeline = toneMapPipeline;
    renderer.toneMapLayout = toneMapLayout;

    return renderer;
  }

  resize(width: number, height: number): void {
    this.context.configure({
      device: this.device,
      format: this.surfaceFormat,
      alphaMode: 'opaque',
    });

    // Destroy old textures
    this.depthTexture.destroy();
    this.gbufferAlbedoTexture.destroy();
    this.gbufferNormalTexture.destroy();
    this.gbufferLinearZTexture.destroy();
    this.hdrTexture.destroy();

    // Recreate depth texture
    const depth = createDepthTexture(this.device, width, height);
    this.depthTexture = depth.texture;
    this.depthTextureView = depth.view;
    this.depthOnlyView = depth.depthOnlyView;

    // Update sky renderer with new depth buffer
    this.skyRenderer.onResize(this.depthOnlyView);

    // Recreate G-buffer textures
    const albedo = createRenderTexture(this.device, width, height, 'rgba8unorm', 'GBuffer Albedo');
    this.gbufferAlbedoTexture = albedo.texture;
    this.gbufferAlbedo = albedo.view;

    const normal = createRenderTexture(this.device, width, height, 'rgba8unorm', 'GBuffer Normal');
    this.gbufferNormalTexture = normal.texture;
    this.gbufferNormal = normal.view;

    const linearZ = createRenderTexture(this.device, width, height, 'r16uint', 'GBuffer LinearZ');
    this.gbufferLinearZTexture = linearZ.texture;
    this.gbufferLinearZ = linearZ.view;

    const hdr = createRenderTexture(this.device, width, height, 'rgba16float', 'HDR Buffer');
    this.hdrTexture = hdr.texture;
    this.hdrView = hdr.view;
  }

  render(
    vpMatrix: Float32Array,
    viewPosition: Float32Array,
    presentTarget: number,
    lightDir: Float32Array,
    ambient: number,
    showBboxes: boolean,
    inverseView: Float32Array,
    inverseProjection: Float32Array,
    sunIlluminance: number,
    sunDiskScale: number,
    sunDiskSize: number,
    fogDensity: number,
    fogHeightFalloff: number,
  ): void {
    // Update per-frame uniforms (reuse pre-allocated buffers)
    for (let i = 0; i < 16; i++) {
      this.perFrameView.setFloat32(i * 4, vpMatrix[i], true);
    }
    this.perFrameView.setFloat32(64, viewPosition[0], true);
    this.perFrameView.setFloat32(68, viewPosition[1], true);
    this.perFrameView.setFloat32(72, viewPosition[2], true);

    this.queue.writeBuffer(this.perFrameUniformBuffer, 0, this.perFrameData);

    // Update lighting uniforms (reuse pre-allocated buffers)
    // light_dir: offset 0
    this.lightingView.setFloat32(0, lightDir[0], true);
    this.lightingView.setFloat32(4, lightDir[1], true);
    this.lightingView.setFloat32(8, lightDir[2], true);
    // ambient: offset 12
    this.lightingView.setFloat32(12, ambient, true);
    // cam_pos_ws: offset 16
    this.lightingView.setFloat32(16, viewPosition[0], true);
    this.lightingView.setFloat32(20, viewPosition[1], true);
    this.lightingView.setFloat32(24, viewPosition[2], true);
    // light_intensity: offset 28
    this.lightingView.setFloat32(28, sunIlluminance, true);
    // inverse_vp = inverseView * inverseProjection: offset 32
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += inverseView[k * 4 + r] * inverseProjection[c * 4 + k];
        }
        this.lightingView.setFloat32(32 + (c * 4 + r) * 4, sum, true);
      }
    }
    // fog_density: offset 96, fog_height_falloff: offset 100
    this.lightingView.setFloat32(96, fogDensity, true);
    this.lightingView.setFloat32(100, fogHeightFalloff, true);

    this.queue.writeBuffer(this.lightingUniformBuffer, 0, this.lightingData);

    // Create per-frame bind group
    const perFrameBindGroup = this.device.createBindGroup({
      label: 'Per Frame Bind Group',
      layout: this.perFrameBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.perFrameUniformBuffer },
        },
      ],
    });

    const encoder = this.device.createCommandEncoder();

    // 1) G-Buffer Pass
    {
      const pass = encoder.beginRenderPass({
        label: 'GBuffer Pass',
        colorAttachments: [
          {
            view: this.gbufferAlbedo,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
          {
            view: this.gbufferNormal,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
          {
            view: this.gbufferLinearZ,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: this.depthTextureView,
          depthClearValue: 0.0, // Reverse-Z: clear to far (0)
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      });

      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, perFrameBindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint16');

      for (const dc of this.staticDrawCalls) {
        pass.setBindGroup(1, dc.bindGroup);
        pass.drawIndexed(CUBE_INDICES.length);
      }
      for (const dc of this.dynamicDrawCalls) {
        pass.setBindGroup(1, dc.bindGroup);
        pass.drawIndexed(CUBE_INDICES.length);
      }

      // Heightmap draws (same G-buffer, different pipeline)
      if (this.heightmapDrawCalls.length > 0) {
        pass.setPipeline(this.heightmapPipeline);
        for (const dc of this.heightmapDrawCalls) {
          pass.setBindGroup(1, dc.bindGroup);
          pass.drawIndexed(CUBE_INDICES.length);
        }
      }

      pass.end();
    }

    // 2) Sky LUT compute pass
    {
      const [w, h] = [this.depthTexture.width, this.depthTexture.height];
      const skyUniforms: SkyUniforms = {
        camera: {
          position: [viewPosition[0], viewPosition[1], viewPosition[2]],
          inverseView: Array.from(inverseView),
          inverseProjection: Array.from(inverseProjection),
        },
        sun: {
          direction: [lightDir[0], lightDir[1], lightDir[2]],
          illuminance: [sunIlluminance, sunIlluminance, sunIlluminance],
          diskLuminanceScale: sunDiskScale,
          diskAngularDiameter: sunDiskSize * (Math.PI / 180),
        },
        screenResolution: [w, h],
      };
      const computePass = encoder.beginComputePass({ label: 'Sky LUT Pass' });
      this.skyRenderer.renderLuts(computePass, skyUniforms);
      computePass.end();
    }

    // 3) Present Pass
    const frameTexture = this.context.getCurrentTexture();
    const frameView = frameTexture.createView();

    if (presentTarget === 4) {
      // Lit mode: render lighting + sky to HDR, then tone map to swapchain
      {
        const pass = encoder.beginRenderPass({
          label: 'HDR Pass',
          colorAttachments: [
            {
              view: this.hdrView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });

        const lightingBind = this.device.createBindGroup({
          label: 'Lighting BG',
          layout: this.lightingLayout,
          entries: [
            { binding: 0, resource: this.gbufferAlbedo },
            { binding: 1, resource: this.gbufferNormal },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: { buffer: this.lightingUniformBuffer } },
            { binding: 4, resource: this.depthOnlyView },
          ],
        });
        pass.setPipeline(this.lightingPipeline);
        pass.setBindGroup(0, lightingBind);
        pass.draw(3);

        // Sky atmosphere on top (additive blend over black sky pixels)
        this.skyRenderer.renderSky(pass);
        pass.end();
      }

      // Tone map HDR → swapchain
      {
        const pass = encoder.beginRenderPass({
          label: 'Tone Map Pass',
          colorAttachments: [
            {
              view: frameView,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        const toneMapBind = this.device.createBindGroup({
          label: 'Tone Map BG',
          layout: this.toneMapLayout,
          entries: [
            { binding: 0, resource: this.hdrView },
            { binding: 1, resource: this.sampler },
          ],
        });
        pass.setPipeline(this.toneMapPipeline);
        pass.setBindGroup(0, toneMapBind);
        pass.draw(3);
        pass.end();
      }
    } else {
      // G-buffer debug modes: render directly to swapchain
      const pass = encoder.beginRenderPass({
        label: 'Present Pass',
        colorAttachments: [
          {
            view: frameView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });

      let pipeline: GPURenderPipeline;
      let layout: GPUBindGroupLayout;
      let view: GPUTextureView;

      switch (presentTarget) {
        case 0:
          pipeline = this.quadPipelineFloat;
          layout = this.quadLayoutFloat;
          view = this.gbufferAlbedo;
          break;
        case 1:
          pipeline = this.quadPipelineFloat;
          layout = this.quadLayoutFloat;
          view = this.gbufferNormal;
          break;
        case 2:
          pipeline = this.quadPipelineUint;
          layout = this.quadLayoutUint;
          view = this.gbufferLinearZ;
          break;
        case 3:
          pipeline = this.quadPipelineFloat;
          layout = this.quadLayoutFloat;
          view = this.gbufferAlbedo;
          break;
        default:
          pipeline = this.quadPipelineFloat;
          layout = this.quadLayoutFloat;
          view = this.gbufferAlbedo;
      }

      const quadBind = this.device.createBindGroup({
        label: 'Quad Present BG',
        layout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: this.sampler },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, quadBind);
      pass.draw(3);
      pass.end();
    }

    // 4) Optional wireframe bounding box pass
    if (showBboxes) {
      const pass = encoder.beginRenderPass({
        label: 'Wireframe Pass',
        colorAttachments: [
          {
            view: frameView,
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      });

      pass.setPipeline(this.wireframePipeline);
      pass.setBindGroup(0, perFrameBindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.edgeIndexBuffer, 'uint16');

      const allDrawCalls = [...this.staticDrawCalls, ...this.dynamicDrawCalls, ...this.heightmapDrawCalls];
      for (const dc of allDrawCalls) {
        const wireframeBg = this.device.createBindGroup({
          label: 'Wireframe BG',
          layout: this.wireframeBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: dc.uniformBuffer },
            },
          ],
        });
        pass.setBindGroup(1, wireframeBg);
        pass.drawIndexed(CUBE_EDGE_INDICES.length);
      }

      pass.end();
    }

    this.queue.submit([encoder.finish()]);
  }

  get_gpu_info(): object {
    return {
      name: this.adapterInfo.description || this.adapterInfo.device || 'Unknown',
      vendor: 0,
      device: 0,
      device_type: this.adapterInfo.architecture || 'Unknown',
      driver: this.adapterInfo.vendor || 'Unknown',
      driver_info: '',
      backend: 'WebGPU',
    };
  }

  private createPerDrawUniformBuffer(
    modelMatrix: ArrayLike<number>,
    invModelMatrix: ArrayLike<number>,
    palette: RGBA[],
  ): GPUBuffer {
    const uniformBuffer = this.device.createBuffer({
      label: 'Per Draw Uniform Buffer',
      size: UNIFORM_SIZES.PER_DRAW,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const uniformData = new Float32Array(32);
    uniformData.set(modelMatrix, 0);
    uniformData.set(invModelMatrix, 16);
    this.queue.writeBuffer(uniformBuffer, 0, uniformData);

    const colorPalette = new Uint32Array(256);
    for (let i = 0; i < palette.length && i < 256; i++) {
      colorPalette[i] = packRGBATuple(palette[i]);
    }
    this.queue.writeBuffer(uniformBuffer, 128, colorPalette);

    return uniformBuffer;
  }

  private createObjectTexture(
    label: string,
    dims: { width: number; height: number; depthOrArrayLayers?: number },
    data: ArrayLike<number>,
    dimension: GPUTextureDimension,
    format: GPUTextureFormat = 'r8uint',
    texelBytes: number = 1,
  ): { texture: GPUTexture; view: GPUTextureView } {
    const texture = this.device.createTexture({
      label,
      size: dims,
      mipLevelCount: 1,
      sampleCount: 1,
      dimension,
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const bytesPerRow = dims.width * texelBytes;
    const rowsPerImage = dimension === '3d' ? dims.height : undefined;
    this.queue.writeTexture(
      { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      new Uint8Array(data),
      { offset: 0, bytesPerRow, ...(rowsPerImage !== undefined && { rowsPerImage }) },
      dims,
    );

    return { texture, view: texture.createView() };
  }

  uploadScene(scene: Scene): void {
    const currentIds = new Set(scene.objects.map((o) => o.id));
    const cachedIds = new Set(this.dynamicDrawCallCache.keys());

    // Remove draw calls for objects no longer in scene
    for (const id of cachedIds) {
      if (!currentIds.has(id)) {
        const dc = this.dynamicDrawCallCache.get(id)!;
        dc.texture.destroy();
        dc.uniformBuffer.destroy();
        this.dynamicDrawCallCache.delete(id);
      }
    }

    // Add draw calls for new objects
    for (const obj of scene.objects) {
      if (this.dynamicDrawCallCache.has(obj.id)) continue;

      const dims = Array.isArray(obj.dims) ? obj.dims : [obj.dims[0], obj.dims[1], obj.dims[2]];
      const [nx, ny, nz] = dims;

      const { texture, view: textureView } = this.createObjectTexture(
        `object_${obj.id}`,
        { width: nx, height: ny, depthOrArrayLayers: nz },
        obj.voxels,
        '3d',
      );

      const palette = obj.palette || scene.palette;
      const uniformBuffer = this.createPerDrawUniformBuffer(obj.modelMatrix, obj.invModelMatrix, palette);

      const bindGroup = this.device.createBindGroup({
        label: 'Per Draw Call Bind Group',
        layout: this.perDrawBindGroupLayout,
        entries: [
          { binding: 0, resource: textureView },
          { binding: 1, resource: { buffer: uniformBuffer } },
        ],
      });

      this.dynamicDrawCallCache.set(obj.id, {
        bindGroup,
        texture,
        textureView,
        uniformBuffer,
      });
    }

    // Build draw call array in scene order
    this.dynamicDrawCalls = scene.objects.map((obj) => this.dynamicDrawCallCache.get(obj.id)!).filter(Boolean);

    // Handle heightmap objects
    const heightmapObjects = scene.heightmapObjects ?? [];
    const hmCurrentIds = new Set(heightmapObjects.map((o) => o.id));
    const hmCachedIds = new Set(this.heightmapDrawCallCache.keys());

    for (const id of hmCachedIds) {
      if (!hmCurrentIds.has(id)) {
        const dc = this.heightmapDrawCallCache.get(id)!;
        dc.texture.destroy();
        dc.uniformBuffer.destroy();
        this.heightmapDrawCallCache.delete(id);
      }
    }

    for (const obj of heightmapObjects) {
      if (this.heightmapDrawCallCache.has(obj.id)) continue;
      this.uploadHeightmapObject(obj, scene.palette);
    }

    this.heightmapDrawCalls = heightmapObjects.map((obj) => this.heightmapDrawCallCache.get(obj.id)!).filter(Boolean);
  }

  private uploadHeightmapObject(obj: HeightmapObject, scenePalette: RGBA[]): void {
    const [nx, nz] = obj.dims;

    const { texture, view: textureView } = this.createObjectTexture(
      `heightmap_${obj.id}`,
      { width: nx, height: nz },
      obj.heightmap,
      '2d',
      'rg8uint',
      2,
    );

    const palette = obj.palette || scenePalette;
    const uniformBuffer = this.createPerDrawUniformBuffer(obj.modelMatrix, obj.invModelMatrix, palette);

    const bindGroup = this.device.createBindGroup({
      label: 'Heightmap Per Draw Bind Group',
      layout: this.heightmapPerDrawBindGroupLayout,
      entries: [
        { binding: 0, resource: textureView },
        { binding: 1, resource: { buffer: uniformBuffer } },
      ],
    });

    this.heightmapDrawCallCache.set(obj.id, {
      bindGroup,
      texture,
      textureView,
      uniformBuffer,
    });
  }

  /** Upload static objects (only call once, these won't be re-uploaded) */
  uploadStaticObjects(objects: VoxelObject[], defaultPalette: RGBA[]): void {
    const drawCallArray: DrawCallData[] = [];

    for (const obj of objects) {
      const dims = Array.isArray(obj.dims) ? obj.dims : [obj.dims[0], obj.dims[1], obj.dims[2]];
      const [nx, ny, nz] = dims;

      const { texture, view: textureView } = this.createObjectTexture(
        `static_${obj.id}`,
        { width: nx, height: ny, depthOrArrayLayers: nz },
        obj.voxels,
        '3d',
      );

      const palette = obj.palette || defaultPalette;
      const uniformBuffer = this.createPerDrawUniformBuffer(obj.modelMatrix, obj.invModelMatrix, palette);

      const bindGroup = this.device.createBindGroup({
        label: 'Static Bind Group',
        layout: this.perDrawBindGroupLayout,
        entries: [
          { binding: 0, resource: textureView },
          { binding: 1, resource: { buffer: uniformBuffer } },
        ],
      });

      drawCallArray.push({
        bindGroup,
        texture,
        textureView,
        uniformBuffer,
      });
    }

    this.staticDrawCalls = drawCallArray;
  }
}

// Helper functions

function createRenderTexture(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
  label: string,
): { texture: GPUTexture; view: GPUTextureView } {
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return { texture, view: texture.createView() };
}

function createDepthTexture(
  device: GPUDevice,
  width: number,
  height: number,
): { texture: GPUTexture; view: GPUTextureView; depthOnlyView: GPUTextureView } {
  const texture = device.createTexture({
    label: 'Depth Texture',
    size: { width, height, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format: 'depth24plus-stencil8',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return {
    texture,
    view: texture.createView(),
    depthOnlyView: texture.createView({ aspect: 'depth-only' }),
  };
}

function createFullscreenQuadPipeline(
  device: GPUDevice,
  surfaceFormat: GPUTextureFormat,
  shaderSrc: string,
  sampleType: GPUTextureSampleType,
  samplerType: GPUSamplerBindingType,
  layoutLabel: string,
  shaderLabel: string,
  pipelineLabel: string,
): { layout: GPUBindGroupLayout; pipeline: GPURenderPipeline } {
  const layout = device.createBindGroupLayout({
    label: layoutLabel,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType,
          viewDimension: '2d',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: samplerType },
      },
    ],
  });

  const shader = device.createShaderModule({
    label: shaderLabel,
    code: shaderSrc,
  });

  const pipelineLayout = device.createPipelineLayout({
    label: `${pipelineLabel} Layout`,
    bindGroupLayouts: [layout],
  });

  const pipeline = device.createRenderPipeline({
    label: pipelineLabel,
    layout: pipelineLayout,
    vertex: {
      module: shader,
      entryPoint: 'vs_main',
    },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{ format: surfaceFormat }],
    },
    primitive: {
      topology: 'triangle-list',
    },
  });

  return { layout, pipeline };
}
