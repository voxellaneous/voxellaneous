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
    speed: 60.0,
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
  }

  setPosition(position: vec3) {
    this.camera.position = position;
  }

  get position(): vec3 {
    return this.camera.position;
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
    mat4.perspective(projectionMatrix, 90 * (Math.PI / 180), aspectRatio, 0.01, 10000.0);

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

  private updateCameraPosition(dt: number) {
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
    // Speed is units per second now
    vec3.scale(motion, motion, this.camera.speed * dt);
    vec3.add(this.camera.position, this.camera.position, motion);
  }

  getUserCmd(): import('./common/types').UserCmd {
    const dir = this.camera.direction;
    return {
      forward: !!this.keysPressedState['KeyW'],
      backward: !!this.keysPressedState['KeyS'],
      left: !!this.keysPressedState['KeyA'],
      right: !!this.keysPressedState['KeyD'],
      jump: !!this.keysPressedState['Space'],
      descend: !!this.keysPressedState['ShiftLeft'],
      viewDir: { x: dir[0], y: dir[1], z: dir[2] },
    };
  }

  update(dt: number) {
    if (!this.isFocused()) return;

    this.updateCameraDirection();
    this.updateCameraPosition(dt);
  }
}
