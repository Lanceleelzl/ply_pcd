import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { ViewportCameraController } from '../../engine/core/ViewportCameraController';

type XY = [number, number];

export function mountIcpRegionControl(options: {
  root: HTMLElement;
  sessionId: string;
  app: pc.Application;
  canvas: HTMLCanvasElement;
  camera: pc.Entity;
  controller: ViewportCameraController;
  projectionChanged(orthographic: boolean): void;
  fixedModel(): ModelId;
  fixedFrame(model: ModelId): pc.Entity;
  bounds(): { min: pc.Vec3; max: pc.Vec3 };
  running(): boolean;
}) {
  const { root, canvas, camera, controller } = options;
  const overlay = root.querySelector<SVGSVGElement>('#icp-region-overlay')!;
  const drawButton = root.querySelector<HTMLButtonElement>('#icp-region-draw')!;
  const editButton = root.querySelector<HTMLButtonElement>('#icp-region-edit')!;
  const clearButton = root.querySelector<HTMLButtonElement>('#icp-region-clear')!;
  const status = root.querySelector<HTMLElement>('#icp-region-status')!;
  const hover = root.querySelector<HTMLElement>('#icp-region-hover')!;
  const vertexDelete = root.querySelector<HTMLButtonElement>('#icp-region-vertex-delete')!;
  const storageKey = (model: ModelId) => `registration-icp-region:${options.sessionId}:${model}`;
  const area = (points: XY[]) => Math.abs(points.reduce((sum, point, i) => {
    const next = points[(i + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  const read = (model: ModelId): XY[] => {
    try {
      const stored = localStorage.getItem(storageKey(model));
      const saved = JSON.parse(stored || 'null');
      if (Array.isArray(saved) && saved.length >= 3 && saved.length <= 256 &&
          saved.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) &&
          area(saved) > 1e-8) return saved;
      if (stored !== null) return [];
      const legacy = JSON.parse(localStorage.getItem(`registration-icp-region:${options.sessionId}`) || 'null');
      if (legacy?.signature?.startsWith(`${model}:`) && Array.isArray(legacy.polygon) &&
          legacy.polygon.length >= 3 && legacy.polygon.length <= 256 &&
          legacy.polygon.every((point: unknown) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) &&
          area(legacy.polygon) > 1e-8) {
        localStorage.setItem(storageKey(model), JSON.stringify(legacy.polygon));
        return legacy.polygon;
      }
    } catch { /* Ignore invalid browser draft. */ }
    return [];
  };
  let fixedModel = options.fixedModel();
  let polygon: XY[] = read(fixedModel);
  let draft: XY[] = [];
  let mode: 'off' | 'draw' | 'edit' = 'off';
  let dragging = -1;
  let selected = -1;
  let beforeDrag: XY[] | null = null;
  let hoverPoint: XY | null = null;
  let hoverKind: 'close' | 'vertex' | 'edge' | 'draw' | null = null;
  let hoverVertex = -1;
  let validation = '';
  let frame = 0;
  const prismColor = new pc.Color(0.2, 0.83, 0.93);

  const persist = () => {
    localStorage.setItem(storageKey(fixedModel), JSON.stringify(polygon));
  };
  const currentFrame = () => options.fixedFrame(options.fixedModel());
  const screen = (point: XY): XY => {
    const origin = currentFrame().getPosition();
    const projected = camera.camera!.worldToScreen(new pc.Vec3(point[0] + origin.x, point[1] + origin.y, origin.z));
    const rect = canvas.getBoundingClientRect();
    return [projected.x * rect.width / canvas.width, projected.y * rect.height / canvas.height];
  };
  const plane = (event: PointerEvent): XY | null => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    const component = camera.camera!;
    const near = component.screenToWorld(x, y, component.nearClip);
    const far = component.screenToWorld(x, y, component.farClip);
    const origin = currentFrame().getPosition();
    const ratio = (origin.z - near.z) / (far.z - near.z);
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
    return [near.x + (far.x - near.x) * ratio - origin.x,
      near.y + (far.y - near.y) * ratio - origin.y];
  };
  const pointer = (event: PointerEvent): XY => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const updateHover = (event: PointerEvent) => {
    if (mode === 'off' || options.running()) { hover.hidden = true; hoverPoint = null; hoverVertex = -1; return; }
    const p = pointer(event);
    let label = '';
    if (mode === 'draw') {
      const closeCandidate = draft.length >= 3 && nearestVertex(event, [draft[0]]) === 0;
      hoverKind = closeCandidate ? 'close' : 'draw';
      hoverPoint = closeCandidate ? draft[0] : plane(event);
      label = closeCandidate ? '点击闭合范围' : '点击添加顶点；Enter 闭合';
    } else {
      const vertex = nearestVertex(event, polygon);
      hoverVertex = vertex;
      const edge = vertex < 0 ? nearestEdge(event) : null;
      hoverKind = vertex >= 0 ? 'vertex' : edge ? 'edge' : null;
      hoverPoint = vertex >= 0 ? polygon[vertex] : edge?.point ?? null;
      label = vertex >= 0 ? polygon.length > 3 ? '拖动顶点；点击 − 或按 Delete 删除' : '拖动顶点；至少保留 3 点' : edge ? '点击边线插入顶点' : '点击顶点或边线编辑；退出即确定';
    }
    hover.hidden = false;
    hover.textContent = label;
    hover.style.left = `${p[0] + 14}px`;
    hover.style.top = `${p[1] + 14}px`;
    canvas.style.cursor = hoverKind === 'vertex' || hoverKind === 'close' ? 'pointer' : hoverKind === 'edge' ? 'copy' : 'crosshair';
  };
  const drawPrism = () => {
    if (polygon.length < 3) return;
    const bounds = options.bounds();
    if (!Number.isFinite(bounds.min.z) || !Number.isFinite(bounds.max.z)) return;
    const origin = currentFrame().getPosition();
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const bottomA = new pc.Vec3(a[0] + origin.x, a[1] + origin.y, bounds.min.z);
      const bottomB = new pc.Vec3(b[0] + origin.x, b[1] + origin.y, bounds.min.z);
      const topA = new pc.Vec3(bottomA.x, bottomA.y, bounds.max.z);
      const topB = new pc.Vec3(bottomB.x, bottomB.y, bounds.max.z);
      options.app.drawLine(bottomA, bottomB, prismColor, false);
      options.app.drawLine(topA, topB, prismColor, false);
      options.app.drawLine(bottomA, topA, prismColor, false);
    }
  };
  const nearestVertex = (event: PointerEvent, points: XY[]): number => {
    const p = pointer(event);
    return points.findIndex(point => {
      const s = screen(point);
      return Math.hypot(s[0] - p[0], s[1] - p[1]) < 12;
    });
  };
  const nearestEdge = (event: PointerEvent): { index: number; point: XY } | null => {
    const p = pointer(event);
    let closest: { index: number; point: XY } | null = null;
    let best = 9;
    for (let i = 0; i < polygon.length; i++) {
      const a = screen(polygon[i]);
      const b = screen(polygon[(i + 1) % polygon.length]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
      const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (distance < best) {
        best = distance;
        const start = polygon[i], end = polygon[(i + 1) % polygon.length];
        closest = { index: i, point: [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])] };
      }
    }
    return closest;
  };
  const close = () => {
    if (draft.length >= 3 && area(draft) > 1e-8) {
      polygon = draft;
      persist();
      mode = 'edit';
      draft = [];
      validation = '';
    } else validation = '范围至少需要 3 个不共线顶点。';
  };
  const redraw = () => {
    const nextFixed = options.fixedModel();
    if (nextFixed !== fixedModel) {
      fixedModel = nextFixed;
      polygon = read(fixedModel);
      draft = [];
      mode = 'off';
      hoverPoint = null;
      hoverVertex = -1;
    }
    const rect = overlay.getBoundingClientRect();
    overlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    const points = (mode === 'draw' ? draft : mode === 'edit' ? polygon : []).map(screen);
    const path = points.map(point => point.join(',')).join(' ');
    const preview = mode === 'draw' && draft.length && hoverPoint ?
      `<line x1="${points.at(-1)![0]}" y1="${points.at(-1)![1]}" x2="${screen(hoverPoint)[0]}" y2="${screen(hoverPoint)[1]}" stroke="#a7f3ff" stroke-width="1.5" stroke-dasharray="5 4" />` : '';
    const markerPoint = hoverPoint ? screen(hoverPoint) : null;
    const marker = markerPoint && hoverKind && mode !== 'off' ? hoverKind === 'edge' ?
      `<svg x="${markerPoint[0] - 12}" y="${markerPoint[1] - 12}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffe16a" stroke-width="1.5" stroke-linejoin="round"><path d="M1 1H23L12 12Z M1 23H23L12 12Z" /></svg>` :
      `<circle cx="${markerPoint[0]}" cy="${markerPoint[1]}" r="8" fill="none" stroke="#fff" stroke-width="2" />` : '';
    overlay.innerHTML = points.length ? `<polyline points="${path}${mode === 'draw' ? '' : ` ${points[0].join(',')}`}"
      fill="${mode === 'draw' ? 'none' : 'rgba(31,190,225,.12)'}" stroke="#35d4ec" stroke-width="2" />${points.map(point =>
      `<circle cx="${point[0]}" cy="${point[1]}" r="5" fill="#35d4ec" />`).join('')}${preview}${marker}` : '';
    const deleteIndex = hoverVertex >= 0 ? hoverVertex : selected;
    vertexDelete.hidden = mode !== 'edit' || options.running() || dragging >= 0 || polygon.length <= 3 || deleteIndex < 0;
    if (!vertexDelete.hidden) {
      const point = screen(polygon[deleteIndex]);
      vertexDelete.style.left = `${point[0] + 10}px`;
      vertexDelete.style.top = `${point[1] - 20}px`;
    }
    status.textContent = validation || (mode === 'draw' ? `已选 ${draft.length} 点；点击首点或完成绘制` :
      polygon.length ? `已设置 ${polygon.length} 顶点${mode === 'edit' ? '；退出即确定' : ''}` : '未设置，使用全模型 ICP');
    drawButton.disabled = editButton.disabled = clearButton.disabled = options.running();
    editButton.disabled ||= polygon.length < 3;
    clearButton.disabled ||= polygon.length < 3 && draft.length === 0;
    drawButton.textContent = mode === 'draw' ? '完成绘制' : mode === 'edit' ? '退出并确定' : '绘制范围';
    drawButton.classList.toggle('active', mode !== 'off');
    editButton.classList.toggle('active', mode === 'edit');
    if (mode === 'off') { hover.hidden = true; canvas.style.cursor = ''; hoverPoint = null; hoverKind = null; hoverVertex = -1; selected = -1; }
    frame = requestAnimationFrame(redraw);
  };
  drawButton.onclick = () => {
    if (mode === 'draw') { close(); return; }
    if (mode === 'edit') { persist(); mode = 'off'; return; }
    draft = [];
    mode = 'draw';
    validation = '';
    controller.setProjection(true);
    options.projectionChanged(true);
    controller.setViewDirection(new pc.Vec3(0, 0, 1), new pc.Vec3(0, 1, 0));
  };
  editButton.onclick = () => {
    mode = mode === 'edit' ? 'off' : 'edit';
    if (mode === 'off') persist();
    if (mode === 'edit') {
      draft = [];
      controller.setProjection(true);
      options.projectionChanged(true);
      controller.setViewDirection(new pc.Vec3(0, 0, 1), new pc.Vec3(0, 1, 0));
    }
  };
  clearButton.onclick = () => { polygon = []; draft = []; mode = 'off'; validation = ''; persist(); };
  vertexDelete.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    const index = hoverVertex >= 0 ? hoverVertex : selected;
    if (mode !== 'edit' || options.running() || polygon.length <= 3 || index < 0) return;
    polygon.splice(index, 1);
    selected = -1;
    hoverVertex = -1;
    hoverPoint = null;
    hover.hidden = true;
    vertexDelete.hidden = true;
    persist();
  };
  const down = (event: PointerEvent) => {
    if (mode === 'off' || options.running() || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const point = plane(event);
    if (!point) return;
    if (mode === 'draw') {
      if (draft.length >= 3 && nearestVertex(event, [draft[0]]) === 0) close();
      else { draft.push(point); validation = ''; }
    } else {
      dragging = nearestVertex(event, polygon);
      selected = dragging;
      if (dragging < 0) {
        const edge = nearestEdge(event);
        if (edge) { polygon.splice(edge.index + 1, 0, edge.point); dragging = edge.index + 1; selected = dragging; persist(); }
      }
      if (dragging >= 0) beforeDrag = polygon.map(vertex => [...vertex] as XY);
    }
    updateHover(event);
  };
  const move = (event: PointerEvent) => {
    if (dragging < 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const point = plane(event);
    if (point) { polygon[dragging] = point; hoverPoint = point; }
  };
  const up = () => {
    if (dragging >= 0) {
      if (area(polygon) > 1e-8) persist();
      else if (beforeDrag) polygon = beforeDrag;
    }
    dragging = -1;
    beforeDrag = null;
  };
  const key = (event: KeyboardEvent) => {
    if (mode === 'draw' && event.key === 'Enter') { event.preventDefault(); close(); }
    if (mode === 'draw' && event.key === 'Escape') { draft = []; mode = 'off'; validation = ''; }
    if (mode === 'edit' && event.key === 'Escape') { persist(); mode = 'off'; }
    if (mode === 'edit' && event.key === 'Delete' && selected >= 0 && polygon.length > 3) {
      polygon.splice(selected, 1); selected = -1; hoverVertex = -1; hoverPoint = null; persist();
    }
  };
  const leave = (event: PointerEvent) => {
    if (event.relatedTarget === vertexDelete) return;
    hover.hidden = true; canvas.style.cursor = ''; hoverPoint = null; hoverVertex = -1;
  };
  vertexDelete.onpointerleave = () => { hoverVertex = -1; selected = -1; hover.hidden = true; };
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', updateHover);
  canvas.addEventListener('pointerleave', leave);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('keydown', key);
  options.app.on('update', drawPrism);
  frame = requestAnimationFrame(redraw);
  return {
    polygon: () => {
      if (mode === 'draw') throw new Error('请先闭合计算范围');
      return polygon.length >= 3 ? polygon.map(point => [...point] as XY) : null;
    },
    destroy: () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', updateHover);
      canvas.removeEventListener('pointerleave', leave);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('keydown', key);
      options.app.off('update', drawPrism);
      vertexDelete.onclick = null;
      vertexDelete.onpointerleave = null;
      vertexDelete.hidden = true;
      canvas.style.cursor = '';
    },
  };
}
