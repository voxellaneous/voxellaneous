import { vec3 } from 'gl-matrix';

export interface CharacterConfig {
  gravity: number;
  jumpVelocity: number;
  playerHeight: number;
  walkSpeed: number;
  maxFallSpeed: number;
  groundSnap: number;
}

// Scale: 1 chunk (32 world units) = 2 meters → 16 wu per meter
const WU_PER_METER = 16;

const DEFAULT_CONFIG: CharacterConfig = {
  gravity: -9.8 * WU_PER_METER, // ~-157 wu/s²
  jumpVelocity: 85, // ~1.5m jump height
  playerHeight: 1.7 * WU_PER_METER, // ~27 wu (eye height)
  walkSpeed: 4 * WU_PER_METER, // ~64 wu/s (brisk walk)
  maxFallSpeed: -50 * WU_PER_METER, // ~-800 wu/s
  groundSnap: 0.15 * WU_PER_METER, // ~2.4 wu
};

const MIN_Y_FLOOR = -500;
// Exponential smoothing rate for camera Y (higher = snappier)
const EYE_SMOOTH_RATE = 20;

export type HeightQueryFn = (x: number, z: number) => number | null;

export class CharacterController {
  private feetPosition: vec3 = [0, 0, 0];
  private velocityX = 0;
  private velocityZ = 0;
  private velocityY = 0;
  private _isGrounded = false;
  private _isFlying = false;
  private lastValidGroundY: number | null = null;
  private smoothEyeY = 0;
  private smoothInitialized = false;
  config: CharacterConfig;

  constructor(config: Partial<CharacterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isFlying(): boolean {
    return this._isFlying;
  }

  get isGrounded(): boolean {
    return this._isGrounded;
  }

  get velocityYValue(): number {
    return this.velocityY;
  }

  /** Initialize feet position from eye position (subtract player height). */
  setFromEyePosition(eyePos: vec3): void {
    this.feetPosition[0] = eyePos[0];
    this.feetPosition[1] = eyePos[1] - this.config.playerHeight;
    this.feetPosition[2] = eyePos[2];
  }

  toggleFlyWalk(): void {
    this._isFlying = !this._isFlying;
    if (this._isFlying) {
      this.velocityY = 0;
      this._isGrounded = false;
    } else {
      this.smoothInitialized = false;
    }
  }

  /** Update in walk mode. Returns eye position for the camera. */
  update(dt: number, inputMotion: vec3, jumpPressed: boolean, queryHeight: HeightQueryFn): vec3 {
    const { gravity, jumpVelocity, walkSpeed, maxFallSpeed, groundSnap, playerHeight } = this.config;

    // Horizontal movement with momentum
    if (this._isGrounded) {
      // On ground: velocity directly follows input
      this.velocityX = inputMotion[0] * walkSpeed;
      this.velocityZ = inputMotion[2] * walkSpeed;
    } else {
      // In air: preserve momentum, allow some steering
      const airAccel = walkSpeed * 5;
      this.velocityX += inputMotion[0] * airAccel * dt;
      this.velocityZ += inputMotion[2] * airAccel * dt;
      // Clamp horizontal speed to walk speed
      const hSpeed = Math.sqrt(this.velocityX * this.velocityX + this.velocityZ * this.velocityZ);
      if (hSpeed > walkSpeed) {
        this.velocityX *= walkSpeed / hSpeed;
        this.velocityZ *= walkSpeed / hSpeed;
      }
    }
    this.feetPosition[0] += this.velocityX * dt;
    this.feetPosition[2] += this.velocityZ * dt;

    // Gravity
    this.velocityY += gravity * dt;
    if (this.velocityY < maxFallSpeed) this.velocityY = maxFallSpeed;

    // Vertical movement
    this.feetPosition[1] += this.velocityY * dt;

    // Ground collision
    const terrainY = queryHeight(this.feetPosition[0], this.feetPosition[2]);

    if (terrainY !== null) {
      this.lastValidGroundY = terrainY;

      if (this.feetPosition[1] <= terrainY) {
        // Below or at terrain — snap up
        this.feetPosition[1] = terrainY;
        this.velocityY = 0;
        this._isGrounded = true;
      } else if (this._isGrounded && this.feetPosition[1] - terrainY < groundSnap) {
        // Walking downhill — snap to ground
        this.feetPosition[1] = terrainY;
        this.velocityY = 0;
      } else {
        this._isGrounded = false;
      }
    }
    // If terrainY is null, preserve current state (no collision)

    // Jump
    if (jumpPressed && this._isGrounded) {
      this.velocityY = jumpVelocity;
      this._isGrounded = false;
    }

    // Safety floor — teleport back up if fell into void
    if (this.feetPosition[1] < MIN_Y_FLOOR) {
      if (this.lastValidGroundY !== null) {
        this.feetPosition[1] = this.lastValidGroundY + 10;
      } else {
        this.feetPosition[1] = 0;
      }
      this.velocityY = 0;
    }

    // Smooth eye Y to avoid stair-stepping on voxel boundaries
    const targetEyeY = this.feetPosition[1] + playerHeight;
    if (!this.smoothInitialized) {
      this.smoothEyeY = targetEyeY;
      this.smoothInitialized = true;
    } else {
      const t = 1 - Math.exp(-EYE_SMOOTH_RATE * dt);
      this.smoothEyeY += (targetEyeY - this.smoothEyeY) * t;
    }

    return [this.feetPosition[0], this.smoothEyeY, this.feetPosition[2]];
  }
}
