import { mat4, vec3 } from 'gl-matrix';
import type { UserCmd } from '../../voxellaneous-common/src/netcode';

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
    const near = 0.1;
    const far = 10000.0;
    mat4.perspectiveZO(projectionMatrix, 90 * (Math.PI / 180), aspectRatio, far, near);

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

  getUserCmd(): UserCmd {
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

  update() {
    if (!this.isFocused()) return;
    this.updateCameraDirection();
  }
}
