const joystickMaxRadius = 60;
const touchLookSensitivity = 0.003;

export class TouchInput {
  private joystickTouchId: number | null = null;
  private lookTouchId: number | null = null;

  private joystickOrigin = { x: 0, y: 0 };
  private joystickDelta = { x: 0, y: 0 };

  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private lastLookPos = { x: 0, y: 0 };

  private _jumpPressed = false;

  private overlay: HTMLDivElement;
  private joystickOuter: HTMLDivElement;
  private joystickInner: HTMLDivElement;
  private jumpButton: HTMLButtonElement;
  private flyButton: HTMLButtonElement;

  constructor(
    canvas: HTMLCanvasElement,
    private onFlyToggle: () => void,
  ) {
    // Overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'touch-overlay';

    // Joystick
    this.joystickOuter = document.createElement('div');
    this.joystickOuter.className = 'touch-joystick-outer';
    this.joystickOuter.style.display = 'none';
    this.joystickInner = document.createElement('div');
    this.joystickInner.className = 'touch-joystick-inner';
    this.joystickOuter.appendChild(this.joystickInner);
    this.overlay.appendChild(this.joystickOuter);

    // Jump button
    this.jumpButton = document.createElement('button');
    this.jumpButton.className = 'touch-jump-btn';
    this.jumpButton.textContent = 'JUMP';
    this.jumpButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._jumpPressed = true;
    });
    this.jumpButton.addEventListener('pointerup', () => {
      this._jumpPressed = false;
    });
    this.jumpButton.addEventListener('pointercancel', () => {
      this._jumpPressed = false;
    });
    this.overlay.appendChild(this.jumpButton);

    // Fly button
    this.flyButton = document.createElement('button');
    this.flyButton.className = 'touch-fly-btn';
    this.flyButton.textContent = 'FLY';
    this.flyButton.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onFlyToggle();
    });
    this.overlay.appendChild(this.flyButton);

    document.body.appendChild(this.overlay);

    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
  }

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    const midX = window.innerWidth / 2;

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];

      if (touch.clientX < midX && this.joystickTouchId === null) {
        this.joystickTouchId = touch.identifier;
        this.joystickOrigin = { x: touch.clientX, y: touch.clientY };
        this.joystickDelta = { x: 0, y: 0 };
        this.showJoystick(touch.clientX, touch.clientY);
      } else if (touch.clientX >= midX && this.lookTouchId === null) {
        this.lookTouchId = touch.identifier;
        this.lastLookPos = { x: touch.clientX, y: touch.clientY };
      }
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();

    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];

      if (touch.identifier === this.joystickTouchId) {
        let dx = touch.clientX - this.joystickOrigin.x;
        let dy = touch.clientY - this.joystickOrigin.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > joystickMaxRadius) {
          dx = (dx / dist) * joystickMaxRadius;
          dy = (dy / dist) * joystickMaxRadius;
        }
        this.joystickDelta = { x: dx, y: dy };
        this.updateJoystickVisual(dx, dy);
      }

      if (touch.identifier === this.lookTouchId) {
        this.lookDeltaX += touch.clientX - this.lastLookPos.x;
        this.lookDeltaY += touch.clientY - this.lastLookPos.y;
        this.lastLookPos = { x: touch.clientX, y: touch.clientY };
      }
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];

      if (touch.identifier === this.joystickTouchId) {
        this.joystickTouchId = null;
        this.joystickDelta = { x: 0, y: 0 };
        this.hideJoystick();
      }

      if (touch.identifier === this.lookTouchId) {
        this.lookTouchId = null;
      }
    }
  };

  private showJoystick(x: number, y: number) {
    this.joystickOuter.style.display = 'block';
    this.joystickOuter.style.left = `${x - joystickMaxRadius}px`;
    this.joystickOuter.style.top = `${y - joystickMaxRadius}px`;
    this.joystickInner.style.transform = 'translate(0px, 0px)';
  }

  private hideJoystick() {
    this.joystickOuter.style.display = 'none';
  }

  private updateJoystickVisual(dx: number, dy: number) {
    this.joystickInner.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Returns normalized joystick vector: x = right, y = forward (negative = backward). */
  getJoystickVector(): { forward: number; right: number } {
    const x = this.joystickDelta.x / joystickMaxRadius;
    const y = -this.joystickDelta.y / joystickMaxRadius; // flip Y: up = forward
    const len = Math.sqrt(x * x + y * y);
    if (len < 0.1) return { forward: 0, right: 0 };
    return { forward: y, right: x };
  }

  /** Consume accumulated look delta (resets after read). */
  consumeLookDelta(): { dx: number; dy: number } {
    const dx = this.lookDeltaX * touchLookSensitivity;
    const dy = this.lookDeltaY * touchLookSensitivity;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return { dx, dy };
  }

  get jumpPressed(): boolean {
    return this._jumpPressed;
  }

  setFlyActive(active: boolean) {
    this.flyButton.classList.toggle('active', active);
  }
}
