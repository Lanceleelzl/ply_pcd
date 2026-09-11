import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import { transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math.ts';
import { createPointCloudEntity, type PointCloudMaterial, type PreviewCloud } from '../../point-cloud.ts';
import { RegistrationDisplay } from '../../registration-display.ts';
import { ResourceScope } from '../../app/resource-scope.ts';

/** Owns the model hierarchy and preview materials for one registration session. */
export class RegistrationScene {
  readonly entities: Record<ModelId, pc.Entity>;
  readonly pointMaterials: Record<ModelId, PointCloudMaterial>;
  readonly clipBox: pc.Entity;
  readonly independentClipBoxes: Record<ModelId, pc.Entity>;
  readonly display: RegistrationDisplay;
  readonly modelDiagonals: Record<ModelId, number>;
  readonly baseDiagonal: number;
  private readonly resources = new ResourceScope();

  constructor(
    app: pc.Application,
    readonly clouds: Record<ModelId, PreviewCloud>,
    origins: Record<ModelId, XYZ>,
    transforms: Record<ModelId, TransformParameters>,
    moving: ModelId,
  ) {
    const root = new pc.Entity('Registration scene');
    app.root.addChild(root);
    this.resources.add(() => root.destroy());
    try {
      const createModel = (model: ModelId) => {
        const entity = createPointCloudEntity(app, clouds[model], new pc.Color(0.68, 0.72, 0.78), `Model ${model.toUpperCase()}`);
        root.addChild(entity);
        const material = entity.render!.meshInstances[0].material as PointCloudMaterial;
        this.resources.add(() => material.destroy());
        return entity;
      };
      this.entities = { a: createModel('a'), b: createModel('b') };
      this.pointMaterials = {
        a: this.entities.a.render!.meshInstances[0].material as PointCloudMaterial,
        b: this.entities.b.render!.meshInstances[0].material as PointCloudMaterial,
      };
      const createBox = (name: string, color: pc.Color) => {
        const box = new pc.Entity(name);
        root.addChild(box);
        box.addComponent('render', { type: 'box' });
        const material = new pc.StandardMaterial();
        this.resources.add(() => material.destroy());
        material.diffuse = color; material.emissive = color.clone().mulScalar(0.25);
        material.opacity = 0.055; material.blendType = pc.BLEND_NORMAL; material.depthWrite = false; material.update();
        box.render!.meshInstances.forEach(instance => { instance.material = material; });
        box.enabled = false;
        return box;
      };
      this.clipBox = createBox('Joint Clipping Box', new pc.Color(0.12, 0.82, 0.68));
      this.independentClipBoxes = {
        a: createBox('Model A Clipping Box', new pc.Color(0.45, 0.65, 0.9)),
        b: createBox('Model B Clipping Box', new pc.Color(1.0, 0.72, 0.08)),
      };
      this.display = new RegistrationDisplay(root, this.entities, origins, transforms);
      this.display.reset(moving);
      this.modelDiagonals = {
        a: clouds.a.max.clone().sub(clouds.a.min).length(),
        b: clouds.b.max.clone().sub(clouds.b.min).length(),
      };
      this.baseDiagonal = clouds.a.max.clone().max(clouds.b.max).sub(clouds.a.min.clone().min(clouds.b.min)).length();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  bounds(): { min: pc.Vec3; max: pc.Vec3 } {
    const min = new pc.Vec3(Infinity, Infinity, Infinity);
    const max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
    for (const model of ['a', 'b'] as const) {
      const cloud = this.clouds[model]; const matrix = this.display.localToDisplay(model);
      for (const x of [cloud.min.x, cloud.max.x]) for (const y of [cloud.min.y, cloud.max.y]) for (const z of [cloud.min.z, cloud.max.z]) {
        const point = new pc.Vec3(...transformXYZ(matrix, [x, y, z]));
        min.min(point); max.max(point);
      }
    }
    return { min, max };
  }

  destroy(): void { this.resources.dispose(); }
}
