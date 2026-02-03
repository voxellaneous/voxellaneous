import { mat4, vec3 } from 'gl-matrix';
import type { UserCmd } from './common/types';

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

  applyUserCmd(cmd: UserCmd, dt: number) {
    const dir = vec3.fromValues(cmd.viewDir.x, cmd.viewDir.y, cmd.viewDir.z);
    if (vec3.length(dir) > 0) {
      vec3.normalize(dir, dir);
      vec3.copy(this.camera.direction, dir);
      vec3.cross(this.camera.right, this.camera.direction, this.camera.up);
      vec3.normalize(this.camera.right, this.camera.right);
    }

    let mx = 0;
    let my = 0;
    let mz = 0;

    const dirX = cmd.viewDir.x || 0;
    const dirZ = cmd.viewDir.z || 0;
    const rightX = -dirZ;
    const rightZ = dirX;

    if (cmd.forward) {
      mx += dirX;
      mz += dirZ;
    }
    if (cmd.backward) {
      mx -= dirX;
      mz -= dirZ;
    }
    if (cmd.right) {
      const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
      const nrX = len > 0 ? rightX / len : 0;
      const nrZ = len > 0 ? rightZ / len : 0;
      mx += nrX;
      mz += nrZ;
    }
    if (cmd.left) {
      const len = Math.sqrt(rightX * rightX + rightZ * rightZ);
      const nrX = len > 0 ? rightX / len : 0;
      const nrZ = len > 0 ? rightZ / len : 0;
      mx -= nrX;
      mz -= nrZ;
    }
    if (cmd.jump) {
      my += 1;
    }
    if (cmd.descend) {
      my -= 1;
    }

    const mLen = Math.sqrt(mx * mx + my * my + mz * mz);
    if (mLen > 0) {
      mx /= mLen;
      my /= mLen;
      mz /= mLen;
      const moveStep = this.camera.speed * dt;
      this.camera.position[0] += mx * moveStep;
      this.camera.position[1] += my * moveStep;
      this.camera.position[2] += mz * moveStep;
    }
  }
}
