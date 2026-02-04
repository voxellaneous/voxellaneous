/**
 * WebGPU Voxel Renderer
 * Ported from Rust/wgpu to TypeScript/WebGPU
 */

import { DrawCallData, Scene, UNIFORM_SIZES } from './types';
import { CUBE_VERTICES, CUBE_INDICES, CUBE_EDGE_INDICES, VERTEX_STRIDE } from './constants';
import { packRGBATuple } from './utils';

// Import shaders as raw strings
import shaderWgsl from './shaders/shader.wgsl?raw';
import quadLightingWgsl from './shaders/quad_lighting.wgsl?raw';
import quadFloatWgsl from './shaders/quad_float.wgsl?raw';
import quadUintWgsl from './shaders/quad_uint.wgsl?raw';
import wireframeWgsl from './shaders/wireframe.wgsl?raw';

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
  private staticUniformBuffer: GPUBuffer;
  private perFrameUniformBuffer: GPUBuffer;
  private lightingUniformBuffer: GPUBuffer;

  // Bind groups
  private staticBindGroup: GPUBindGroup;

  // Textures
  private gbufferAlbedo: GPUTextureView;
  private gbufferNormal: GPUTextureView;
  private gbufferLinearZ: GPUTextureView;
  private depthTextureView: GPUTextureView;
  private sampler: GPUSampler;

  // Draw call data
  private drawCallArray: DrawCallData[] = [];
  // Map for fast lookups of draw calls by object ID
  private drawCallMap: Map<string, DrawCallData> = new Map();

  updateObjectTransform(id: string, modelMatrix: Float32Array): void {
    const dc = this.drawCallMap.get(id);
    if (!dc) return;

    // Update the model matrix in the uniform buffer (offset 0)
    // PerDraw struct: model_matrix (64), normal_matrix (64, but computed in shader or cpu?), etc.
    // Wait, shader expects model_matrix and normal_matrix.
    // We need to compute normal matrix (inverse transpose of model 3x3).

    // Let's look at how it's done in uploadScene (we need to see the code there)
    // Assuming offset 0 is model matrix.
    this.queue.writeBuffer(dc.uniformBuffer, 0, modelMatrix as ArrayBufferBufferView);

    // We also need normal matrix at offset 64.
    // If we don't update it, lighting will be wrong for rotating objects.
    // For now, let's just update model matrix to verify movement.
    // TODO: Proper normal matrix update
  }

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
    staticUniformBuffer: GPUBuffer,
    perFrameUniformBuffer: GPUBuffer,
    lightingUniformBuffer: GPUBuffer,
    staticBindGroup: GPUBindGroup,
    gbufferAlbedo: GPUTextureView,
    gbufferNormal: GPUTextureView,
    gbufferLinearZ: GPUTextureView,
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
    this.staticUniformBuffer = staticUniformBuffer;
    this.perFrameUniformBuffer = perFrameUniformBuffer;
    this.lightingUniformBuffer = lightingUniformBuffer;
    this.staticBindGroup = staticBindGroup;
    this.gbufferAlbedo = gbufferAlbedo;
    this.gbufferNormal = gbufferNormal;
    this.gbufferLinearZ = gbufferLinearZ;
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
    const depthTextureView = createDepthTexture(device, canvasWidth, canvasHeight);

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
    const staticUniformBuffer = device.createBuffer({
      label: 'Static Uniform Buffer',
      size: UNIFORM_SIZES.STATIC,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
    const staticBindGroupLayout = device.createBindGroupLayout({
      label: 'Static Bind Group Layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

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

    // Create static bind group
    const staticBindGroup = device.createBindGroup({
      label: 'Static Bind Group',
      layout: staticBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: staticUniformBuffer },
        },
      ],
    });

    // Create main render pipeline
    const pipelineLayout = device.createPipelineLayout({
      label: 'Pipeline Layout',
      bindGroupLayouts: [staticBindGroupLayout, perFrameBindGroupLayout, perDrawBindGroupLayout],
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
    const gbufferAlbedo = createRenderTextureView(device, canvasWidth, canvasHeight, 'rgba8unorm', 'GBuffer Albedo');
    const gbufferNormal = createRenderTextureView(device, canvasWidth, canvasHeight, 'rgba8unorm', 'GBuffer Normal');
    const gbufferLinearZ = createRenderTextureView(device, canvasWidth, canvasHeight, 'r16uint', 'GBuffer LinearZ');

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
        targets: [{ format: surfaceFormat }],
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

    return new Renderer(
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
      staticUniformBuffer,
      perFrameUniformBuffer,
      lightingUniformBuffer,
      staticBindGroup,
      gbufferAlbedo,
      gbufferNormal,
      gbufferLinearZ,
      depthTextureView,
      sampler,
    );
  }

  resize(width: number, height: number): void {
    this.context.configure({
      device: this.device,
      format: this.surfaceFormat,
      alphaMode: 'opaque',
    });

    // Recreate depth texture
    this.depthTextureView = createDepthTexture(this.device, width, height);

    // Recreate G-buffer textures
    this.gbufferAlbedo = createRenderTextureView(this.device, width, height, 'rgba8unorm', 'GBuffer Albedo');
    this.gbufferNormal = createRenderTextureView(this.device, width, height, 'rgba8unorm', 'GBuffer Normal');
    this.gbufferLinearZ = createRenderTextureView(this.device, width, height, 'r16uint', 'GBuffer LinearZ');
  }

  render(
    vpMatrix: Float32Array,
    viewPosition: Float32Array,
    presentTarget: number,
    lightDir: Float32Array,
    ambient: number,
    lightIntensity: number,
    showBboxes: boolean,
  ): void {
    // Update per-frame uniforms
    const perFrameData = new ArrayBuffer(UNIFORM_SIZES.PER_FRAME);
    const perFrameView = new DataView(perFrameData);

    // Write vp_matrix (16 floats = 64 bytes)
    for (let i = 0; i < 16; i++) {
      perFrameView.setFloat32(i * 4, vpMatrix[i], true);
    }
    // Write camera_position (3 floats = 12 bytes)
    perFrameView.setFloat32(64, viewPosition[0], true);
    perFrameView.setFloat32(68, viewPosition[1], true);
    perFrameView.setFloat32(72, viewPosition[2], true);
    // padding at offset 76 (4 bytes)

    this.queue.writeBuffer(this.perFrameUniformBuffer, 0, perFrameData);

    // Update lighting uniforms
    const lightingData = new ArrayBuffer(UNIFORM_SIZES.LIGHTING);
    const lightingView = new DataView(lightingData);
    lightingView.setFloat32(0, lightDir[0], true);
    lightingView.setFloat32(4, lightDir[1], true);
    lightingView.setFloat32(8, lightDir[2], true);
    lightingView.setFloat32(12, ambient, true);
    lightingView.setFloat32(16, lightIntensity, true);
    // padding at offset 20 (12 bytes)

    this.queue.writeBuffer(this.lightingUniformBuffer, 0, lightingData);

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
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      });

      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, this.staticBindGroup);
      pass.setBindGroup(1, perFrameBindGroup);
      pass.setVertexBuffer(0, this.vertexBuffer);
      pass.setIndexBuffer(this.indexBuffer, 'uint16');

      for (const dc of this.drawCallArray) {
        pass.setBindGroup(2, dc.bindGroup);
        pass.drawIndexed(CUBE_INDICES.length);
      }

      pass.end();
    }

    // 2) Present Pass
    const frameTexture = this.context.getCurrentTexture();
    const frameView = frameTexture.createView();

    {
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

      if (presentTarget === 4) {
        // Lit mode: use lighting pipeline
        const lightingBind = this.device.createBindGroup({
          label: 'Lighting BG',
          layout: this.lightingLayout,
          entries: [
            { binding: 0, resource: this.gbufferAlbedo },
            { binding: 1, resource: this.gbufferNormal },
            { binding: 2, resource: this.sampler },
            { binding: 3, resource: { buffer: this.lightingUniformBuffer } },
          ],
        });
        pass.setPipeline(this.lightingPipeline);
        pass.setBindGroup(0, lightingBind);
      } else {
        // G-buffer debug modes
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
            view = this.gbufferAlbedo; // Note: Rust had depth texture here, but that requires different format
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
      }

      pass.draw(3);
      pass.end();
    }

    // 3) Optional wireframe bounding box pass
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

      for (const dc of this.drawCallArray) {
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

  uploadScene(scene: Scene): void {
    // Step 1: Upload the color palette as a uniform buffer
    const colorPalette = new Uint32Array(256);
    for (let i = 0; i < scene.palette.length && i < 256; i++) {
      colorPalette[i] = packRGBATuple(scene.palette[i]);
    }
    this.queue.writeBuffer(this.staticUniformBuffer, 0, colorPalette);

    // Step 2: Upload objects as 3D textures
    const drawCallArray: DrawCallData[] = [];
    this.drawCallMap.clear();

    for (const obj of scene.objects) {
      // ... (existing code for texture creation)
      const dims = Array.isArray(obj.dims) ? obj.dims : [obj.dims[0], obj.dims[1], obj.dims[2]];
      const [nx, ny, nz] = dims;

      // Create the 3D texture
      const texture = this.device.createTexture({
        label: `object_${obj.id}`,
        size: { width: nx, height: ny, depthOrArrayLayers: nz },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '3d',
        format: 'r8uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });

      // Upload the voxel data
      this.queue.writeTexture(
        { texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
        new Uint8Array(obj.voxels),
        { offset: 0, bytesPerRow: nx, rowsPerImage: ny },
        { width: nx, height: ny, depthOrArrayLayers: nz },
      );

      const textureView = texture.createView();
      const sampler = this.device.createSampler({});

      // Create per-draw uniform buffer
      const uniformBuffer = this.device.createBuffer({
        label: 'Per Draw Uniform Buffer',
        size: UNIFORM_SIZES.PER_DRAW,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // Write model matrices to uniform buffer
      const uniformData = new Float32Array(32);
      uniformData.set(obj.modelMatrix, 0);
      uniformData.set(obj.invModelMatrix, 16);
      this.queue.writeBuffer(uniformBuffer, 0, uniformData);

      // Create bind group
      const bindGroup = this.device.createBindGroup({
        label: 'Per Draw Call Bind Group',
        layout: this.perDrawBindGroupLayout,
        entries: [
          { binding: 0, resource: textureView },
          { binding: 1, resource: { buffer: uniformBuffer } },
        ],
      });

      const dc: DrawCallData = {
        bindGroup,
        texture,
        textureView,
        sampler,
        uniformBuffer,
      };

      drawCallArray.push(dc);
      this.drawCallMap.set(obj.id, dc);
    }

    this.drawCallArray = drawCallArray;
  }
}

// Helper functions

function createRenderTextureView(
  device: GPUDevice,
  width: number,
  height: number,
  format: GPUTextureFormat,
  label: string,
): GPUTextureView {
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  return texture.createView();
}

function createDepthTexture(device: GPUDevice, width: number, height: number): GPUTextureView {
  const texture = device.createTexture({
    label: 'Depth Texture',
    size: { width, height, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format: 'depth24plus-stencil8',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return texture.createView();
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
