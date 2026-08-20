import * as pc from 'playcanvas';

export interface PreviewCloud {
  positions: Float32Array;
  count: number;
  min: pc.Vec3;
  max: pc.Vec3;
}

export async function loadPreview(url: string): Promise<PreviewCloud> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`加载预览失败：HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer, 0, 8);
  const magic = new TextDecoder().decode(bytes);
  if (magic !== 'PCPV0001') throw new Error(`不支持的点云预览格式：${magic}`);
  const view = new DataView(buffer);
  const count = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (stride !== 12 || buffer.byteLength !== 40 + count * stride) throw new Error('点云预览文件长度不正确');
  const min = new pc.Vec3(view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true));
  const max = new pc.Vec3(view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true));
  return { positions: new Float32Array(buffer, 40, count * 3), count, min, max };
}

export function createPointCloudEntity(app: pc.Application, cloud: PreviewCloud, color: pc.Color, name: string): pc.Entity {
  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(cloud.positions);
  mesh.update(pc.PRIMITIVE_POINTS);
  const material = new pc.StandardMaterial();
  material.diffuse = color;
  material.emissive = color;
  material.useLighting = false;
  material.update();
  const entity = new pc.Entity(name);
  entity.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
  return entity;
}
