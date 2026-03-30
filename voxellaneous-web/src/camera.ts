import { mat4, vec3 } from 'gl-matrix';

const maxCameraPitch = Math.PI / 2 - 0.1;
const mouseSensitivity = 0.001;

export class CameraModule {
  private keysPressedState: { [key: KeyboardEvent['code']]: boolean } = {};

  private camera = {
    position: [0, 0, 0] as vec3,
    direction: [0, 0, 1] as vec3,
    right: [-1, 0, 0] as vec3,
    up: [0, 1, 0] as vec3,
    yaw: 0,
    pitch: 0,
    speed: 60,
  };

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener('click', () => {
      canvas.requestPointerLock();
    });

    window.addEventListener('keydown', (event) => {
      this.keysPressedState[event.code] = true;
    });

    window.addEventListener('keyup', (event) => {
      this.keysPressedState[event.code] = false;
    });

    window.addEventListener('mousemove', (event) => {
      this.handleMouseMove(event);
    });

    document.addEventListener('pointerlockchange', () => {
      if (!this.isFocused()) {
        this.keysPressedState = {};
      }
    });
  }

  setPosition(position: vec3) {
    this.camera.position = position;
  }

  get position(): vec3 {
    return this.camera.position;
  }

  setSpeed(speed: number) {
    this.camera.speed = speed;
  }

  get speed(): number {
    return this.camera.speed;
  }

  setDirection(direction: vec3) {
    this.camera.yaw = Math.atan2(direction[0], direction[2]);
    this.camera.pitch = Math.asin(direction[1]);
    this.updateCameraDirection();
  }

  get direction(): vec3 {
    return this.camera.direction;
  }

  get right(): vec3 {
    return this.camera.right;
  }

  isFocused(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  private buildViewAndProjection(): { view: mat4; projection: mat4 } {
    const view = mat4.create();
    const cameraTarget: vec3 = [0, 0, 0];
    vec3.add(cameraTarget, this.camera.position, this.camera.direction);
    mat4.lookAt(view, this.camera.position, cameraTarget, this.camera.up);

    const aspectRatio = this.canvas.width / this.canvas.height;
    const projection = mat4.create();
    // Infinite reverse-Z: near→1, far(∞)→0. No far plane clipping.
    const near = 0.1;
    const f = 1.0 / Math.tan((90 * Math.PI / 180) / 2);
    // Column-major: [col0, col1, col2, col3]
    projection[0]  = f / aspectRatio;
    projection[1]  = 0;
    projection[2]  = 0;
    projection[3]  = 0;
    projection[4]  = 0;
    projection[5]  = f;
    projection[6]  = 0;
    projection[7]  = 0;
    projection[8]  = 0;
    projection[9]  = 0;
    projection[10] = 0;
    projection[11] = -1;
    projection[12] = 0;
    projection[13] = 0;
    projection[14] = near;
    projection[15] = 0;

    return { view, projection };
  }

  calculateMVP(): mat4 {
    const { view, projection } = this.buildViewAndProjection();
    const mvpMatrix = mat4.create();
    mat4.multiply(mvpMatrix, projection, view);
    return mvpMatrix;
  }

  getCameraMatrices(): { inverseView: mat4; inverseProjection: mat4 } {
    const { view, projection } = this.buildViewAndProjection();
    const inverseView = mat4.create();
    mat4.invert(inverseView, view);
    const inverseProjection = mat4.create();
    mat4.invert(inverseProjection, projection);
    return { inverseView, inverseProjection };
  }

  private handleMouseMove = (event: MouseEvent) => {
    if (!this.isFocused()) return;

    const dx = event.movementX;
    const dy = event.movementY;

    this.camera.yaw -= dx * mouseSensitivity;
    this.camera.pitch -= dy * mouseSensitivity;

    if (this.camera.pitch > maxCameraPitch) this.camera.pitch = maxCameraPitch;
    if (this.camera.pitch < -maxCameraPitch) this.camera.pitch = -maxCameraPitch;
  };

  private updateCameraDirection() {
    const direction: vec3 = [
      Math.cos(this.camera.pitch) * Math.sin(this.camera.yaw),
      Math.sin(this.camera.pitch),
      Math.cos(this.camera.pitch) * Math.cos(this.camera.yaw),
    ];
    vec3.normalize(this.camera.direction, direction);

    vec3.cross(this.camera.right, this.camera.direction, this.camera.up);
    vec3.normalize(this.camera.right, this.camera.right);
  }

  /** Returns the normalized WASD+Space/Shift input motion vector without applying it. */
  getInputMotion(): vec3 {
    const motion: vec3 = [0, 0, 0];
    if (this.keysPressedState['KeyW']) {
      const [x, _, z] = this.camera.direction;
      vec3.add(motion, motion, [x, 0, z]);
    }
    if (this.keysPressedState['KeyS']) {
      const [x, _, z] = this.camera.direction;
      vec3.subtract(motion, motion, [x, 0, z]);
    }
    if (this.keysPressedState['KeyD']) {
      const [x, _, z] = this.camera.right;
      vec3.add(motion, motion, [x, 0, z]);
    }
    if (this.keysPressedState['KeyA']) {
      const [x, _, z] = this.camera.right;
      vec3.subtract(motion, motion, [x, 0, z]);
    }
    if (this.keysPressedState['Space']) {
      vec3.add(motion, motion, this.camera.up);
    }
    if (this.keysPressedState['ShiftLeft']) {
      vec3.subtract(motion, motion, this.camera.up);
    }
    if (vec3.length(motion) > 0) {
      vec3.normalize(motion, motion);
    }
    return motion;
  }

  /** Returns true if the given key is currently pressed. */
  isKeyPressed(code: string): boolean {
    return !!this.keysPressedState[code];
  }

  /** Apply external look delta (e.g. from touch input). Adjusts yaw/pitch and updates direction. */
  applyLookDelta(dx: number, dy: number): void {
    this.camera.yaw -= dx;
    this.camera.pitch -= dy;
    if (this.camera.pitch > maxCameraPitch) this.camera.pitch = maxCameraPitch;
    if (this.camera.pitch < -maxCameraPitch) this.camera.pitch = -maxCameraPitch;
    this.updateCameraDirection();
  }

  /** Updates camera direction from mouse input. Call every frame. */
  updateLook(): void {
    if (!this.isFocused()) return;
    this.updateCameraDirection();
  }

  /** Applies fly movement: input motion scaled by speed and dt. */
  updateFlyMovement(dt: number): void {
    if (!this.isFocused()) return;
    const motion = this.getInputMotion();
    if (vec3.length(motion) === 0) return;
    vec3.scale(motion, motion, this.camera.speed * dt);
    vec3.add(this.camera.position, this.camera.position, motion);
  }

  update() {
    if (!this.isFocused()) return;

    this.updateCameraDirection();
    // Legacy: non-dt fly movement (kept for backward compat during transition)
    const motion = this.getInputMotion();
    if (vec3.length(motion) === 0) return;
    vec3.scale(motion, motion, this.camera.speed);
    vec3.add(this.camera.position, this.camera.position, motion);
  }
}
