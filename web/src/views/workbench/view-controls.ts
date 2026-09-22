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
  corners.forEach(corner => {
    const [x, y, z] = corner.dataset.direction!.split(',').map(Number);
    const sx = x;
    const sy = -y;
    const sz = z;
    const cut = 8.5;
    const tip = [0, 0, 0];
    const px = [-sx * cut, 0, 0];
    const py = [0, -sy * cut, 0];
    const pz = [0, 0, -sz * cut];
    corner.style.transform = `translate3d(${sx * 30}px, ${sy * 30}px, ${sz * 30}px)`;
    const facets = [
      { points: [tip, py, pz], normal: [sx, 0, 0] },
      { points: [tip, px, pz], normal: [0, sy, 0] },
      { points: [tip, px, py], normal: [0, 0, sz] },
      { points: [px, py, pz], normal: [-sx, -sy, -sz] },
    ];
    corner.querySelectorAll<HTMLElement>('.cube-corner-facet').forEach((facet, index) => {
      let [p1, p2, p3] = facets[index].points;
      const normal = facets[index].normal;
      const first = p2.map((value, axis) => value - p1[axis]);
      const second = p3.map((value, axis) => value - p1[axis]);
      const cross = [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
      if (cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) < 0) [p1, p2] = [p2, p1];
      const along = p2.map((value, axis) => (value - p1[axis]) / 16);
      const rise = p3.map((value, axis) => (value - (p1[axis] + p2[axis]) / 2) / 16);
      facet.style.transform = `matrix3d(${along[0]},${along[1]},${along[2]},0,${rise[0]},${rise[1]},${rise[2]},0,${normal[0]},${normal[1]},${normal[2]},0,${8 + p1[0]},${8 + p1[1]},${p1[2]},1)`;
    });
  });
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
    const depths = corners.map(corner => {
      const [x, y, z] = corner.dataset.direction!.split(',').map(Number);
      return direction.x * x + direction.y * y + direction.z * z;
    });
    const hiddenDepth = Math.min(...depths);
    corners.forEach((corner, index) => {
      corner.hidden = depths[index] <= hiddenDepth + 1e-4;
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
