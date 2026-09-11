import { createCubeLabels } from '../../cube-labels';
import type { CameraOrientation } from '../../engine/core/ViewportCameraController';
import type { XYZ } from '../../coordinate-math';

interface ViewControlsCommands {
  direction(value: XYZ): void;
  orbit(horizontal: number, vertical: number): void;
  projection(orthographic: boolean): void;
}

export function mountViewControls(root: HTMLElement, commands: ViewControlsCommands) {
  const events = new AbortController();
  const signal = events.signal;
  const viewCube = root.querySelector<HTMLElement>('.view-cube')!;
  const updateCubeLabels = createCubeLabels(viewCube);
  const corners = Array.from(root.querySelectorAll<HTMLElement>('.cube-corner'));
  let cubeDragging = false;
  let cubeDragMoved = false;
  let cubeDragDistance = 0;
  let cubeDragAxis: 'horizontal' | 'vertical' | 'free' | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  const update = ({ right, cubeUp, direction }: CameraOrientation) => {
    viewCube.style.transform = `matrix3d(${right.x},${-cubeUp.x},${direction.x},0,${-right.y},${cubeUp.y},${-direction.y},0,${right.z},${-cubeUp.z},${direction.z},0,0,0,0,1)`;
    updateCubeLabels();
    const inverse = `matrix3d(${right.x},${-right.y},${right.z},0,${-cubeUp.x},${cubeUp.y},${-cubeUp.z},0,${direction.x},${-direction.y},${direction.z},0,0,0,0,1)`;
    corners.forEach(corner => {
      const [x, y, z] = corner.dataset.direction!.split(',').map(Number);
      corner.style.transform = `translate3d(${x * 30}px, ${y * -30}px, ${z * 30}px) ${inverse}`;
    });
  };

  root.querySelectorAll<HTMLButtonElement>('.view-cube button[data-direction]').forEach(button => {
    button.addEventListener('click', () => {
      const [x, y, z] = button.dataset.direction!.split(',').map(Number);
      commands.direction([x, y, z]);
    }, { signal });
  });
  const scene = root.querySelector<HTMLElement>('.view-cube-scene')!;
  scene.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cubeDragging = true;
    cubeDragMoved = false;
    cubeDragDistance = 0;
    cubeDragAxis = null;
    startX = lastX = event.clientX;
    startY = lastY = event.clientY;
  }, { signal });
  scene.addEventListener('pointermove', event => {
    if (!cubeDragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    cubeDragDistance += Math.hypot(dx, dy);
    if (cubeDragDistance > 5 && !cubeDragMoved) {
      cubeDragMoved = true;
      const totalX = event.clientX - startX;
      const totalY = event.clientY - startY;
      cubeDragAxis = Math.abs(totalY) > Math.abs(totalX) * 1.5 ? 'vertical'
        : Math.abs(totalX) > Math.abs(totalY) * 1.5 ? 'horizontal' : 'free';
      scene.setPointerCapture(event.pointerId);
      scene.classList.add('dragging');
    }
    if (cubeDragMoved) commands.orbit((cubeDragAxis === 'vertical' ? 0 : dx) * 0.6, (cubeDragAxis === 'horizontal' ? 0 : dy) * 0.6);
  }, { signal });
  scene.addEventListener('pointerup', event => {
    cubeDragging = false;
    scene.classList.remove('dragging');
    if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
  }, { signal });
  scene.addEventListener('pointercancel', () => {
    cubeDragging = false;
    scene.classList.remove('dragging');
  }, { signal });
  scene.addEventListener('click', event => {
    if (!cubeDragMoved) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cubeDragMoved = false;
  }, { capture: true, signal });
  root.querySelectorAll<HTMLButtonElement>('.projection-switch button').forEach(button => {
    button.addEventListener('click', () => {
      const orthographic = button.dataset.projection === 'orthographic';
      commands.projection(orthographic);
      root.querySelectorAll('.projection-switch button').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
    }, { signal });
  });
  return { update, destroy: () => events.abort() };
}
