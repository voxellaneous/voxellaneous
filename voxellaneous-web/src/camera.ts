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
    speed: 1.0,
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

  isFocused(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  calculateMVP(): mat4 {
    const viewMatrix = mat4.create();
    const cameraTarget: vec3 = [0, 0, 0];
    vec3.add(cameraTarget, this.camera.position, this.camera.direction);
    mat4.lookAt(viewMatrix, this.camera.position, cameraTarget, this.camera.up);

    const aspectRatio = this.canvas.width / this.canvas.height;
    const projectionMatrix = mat4.create();
    // Infinite reverse-Z: near→1, far(∞)→0. No far plane clipping.
    const near = 0.1;
    const f = 1.0 / Math.tan((90 * Math.PI / 180) / 2);
    // Column-major: [col0, col1, col2, col3]
    projectionMatrix[0]  = f / aspectRatio;
    projectionMatrix[1]  = 0;
    projectionMatrix[2]  = 0;
    projectionMatrix[3]  = 0;
    projectionMatrix[4]  = 0;
    projectionMatrix[5]  = f;
    projectionMatrix[6]  = 0;
    projectionMatrix[7]  = 0;
    projectionMatrix[8]  = 0;
    projectionMatrix[9]  = 0;
    projectionMatrix[10] = 0;
    projectionMatrix[11] = -1;
    projectionMatrix[12] = 0;
    projectionMatrix[13] = 0;
    projectionMatrix[14] = near;
    projectionMatrix[15] = 0;

    const mvpMatrix = mat4.create();
    mat4.multiply(mvpMatrix, projectionMatrix, viewMatrix);

    return mvpMatrix;
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

  private updateCameraPosition() {
    let motion: vec3 = [0, 0, 0];
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
    if (vec3.length(motion) === 0) return;

    vec3.normalize(motion, motion);
    vec3.scale(motion, motion, this.camera.speed);
    vec3.add(this.camera.position, this.camera.position, motion);
  }

  update() {
    if (!this.isFocused()) return;

    this.updateCameraDirection();
    this.updateCameraPosition();
  }
}
