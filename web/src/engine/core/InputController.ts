import type { ViewportCameraController, ViewportInputDelegate } from './ViewportCameraController';

export class InputController {
  private readonly events = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: ViewportCameraController,
    delegate: ViewportInputDelegate,
  ) {
    let navigation: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;
    const { signal } = this.events;

    canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    canvas.addEventListener('pointermove', event => {
      if (delegate.pointerMove?.(event)) navigation = null;
    }, { capture: true, signal });
    canvas.addEventListener('pointerleave', () => delegate.pointerLeave?.(), { signal });
    canvas.addEventListener('pointerdown', event => {
      if (delegate.pointerDown?.(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigation = null;
        return;
      }
      if (delegate.navigationBlocked?.(event)) return;
      if (event.button === 0) navigation = 'orbit';
      else if (event.button === 1) navigation = 'pan';
      else return;
      lastX = event.clientX;
      lastY = event.clientY;
    }, { capture: true, signal });
    window.addEventListener('pointerup', event => {
      delegate.pointerUp?.(event);
      navigation = null;
      canvas.style.cursor = '';
    }, { signal });
    window.addEventListener('pointermove', event => {
      if (!navigation || delegate.dragBlocked?.()) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (navigation === 'orbit') camera.orbitByPixels(dx, dy);
      else camera.panByPixels(dx, dy);
    }, { signal });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      camera.zoom(event.deltaY);
    }, { passive: false, signal });
  }

  destroy(): void {
    this.events.abort();
  }
}
