import * as pc from 'playcanvas';

const shaderGLSL = /* glsl */`
uniform float uClipEnabled;
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform float uClipBoxEnabled;
uniform mat4 uClipWorldToBox;
uniform vec3 uOriginClipSides;
uniform mat4 uClipWorldToOrigin;

void modifySplatCenter(inout vec3 center) {}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    bool insideAxis = uClipEnabled < 0.5 || (all(greaterThanEqual(modifiedCenter, uClipMin))
        && all(lessThanEqual(modifiedCenter, uClipMax)));
    vec3 boxPoint = (uClipWorldToBox * vec4(modifiedCenter, 1.0)).xyz;
    bool insideBox = all(lessThanEqual(abs(boxPoint), vec3(0.5)));
    vec3 originPoint = (uClipWorldToOrigin * vec4(modifiedCenter, 1.0)).xyz;
    bool insideOrigin = (uOriginClipSides.x < 0.5 || originPoint.x >= 0.0) && (uOriginClipSides.x > -0.5 || originPoint.x <= 0.0)
        && (uOriginClipSides.y < 0.5 || originPoint.y >= 0.0) && (uOriginClipSides.y > -0.5 || originPoint.y <= 0.0)
        && (uOriginClipSides.z < 0.5 || originPoint.z >= 0.0) && (uOriginClipSides.z > -0.5 || originPoint.z <= 0.0);
    if (!insideAxis || (uClipEnabled > 0.5 && uClipBoxEnabled > 0.5 && !insideBox) || !insideOrigin) scale = vec3(0.0);
}

void modifySplatColor(vec3 center, inout vec4 color) {}
`;

const shaderWGSL = /* wgsl */`
uniform uClipEnabled: f32;
uniform uClipMin: vec3f;
uniform uClipMax: vec3f;
uniform uClipBoxEnabled: f32;
uniform uClipWorldToBox: mat4x4f;
uniform uOriginClipSides: vec3f;
uniform uClipWorldToOrigin: mat4x4f;

fn modifySplatCenter(center: ptr<function, vec3f>) {}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let insideAxis = uniform.uClipEnabled < 0.5 || (all(modifiedCenter >= uniform.uClipMin)
        && all(modifiedCenter <= uniform.uClipMax));
    let boxPoint = (uniform.uClipWorldToBox * vec4f(modifiedCenter, 1.0)).xyz;
    let insideBox = all(abs(boxPoint) <= vec3f(0.5));
    let originPoint = (uniform.uClipWorldToOrigin * vec4f(modifiedCenter, 1.0)).xyz;
    let insideOrigin = (uniform.uOriginClipSides.x < 0.5 || originPoint.x >= 0.0) && (uniform.uOriginClipSides.x > -0.5 || originPoint.x <= 0.0)
        && (uniform.uOriginClipSides.y < 0.5 || originPoint.y >= 0.0) && (uniform.uOriginClipSides.y > -0.5 || originPoint.y <= 0.0)
        && (uniform.uOriginClipSides.z < 0.5 || originPoint.z >= 0.0) && (uniform.uOriginClipSides.z > -0.5 || originPoint.z <= 0.0);
    if (!insideAxis || (uniform.uClipEnabled > 0.5 && uniform.uClipBoxEnabled > 0.5 && !insideBox) || !insideOrigin) {
        *scale = vec3f(0.0);
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {}
`;

const UPDATE_INTERVAL_MS = 75;

interface ClipValues {
  enabled: number;
  boxEnabled: number;
  min: Float32Array;
  max: Float32Array;
  worldToBox: Float32Array;
  originSides: Float32Array;
  worldToOrigin: Float32Array;
}

const arraysEqual = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export class GaussianClipController {
  private readonly component: pc.GSplatComponent;
  private applied: ClipValues | null = null;
  private lastAppliedAt = Number.NEGATIVE_INFINITY;

  constructor(component: pc.GSplatComponent) {
    this.component = component;
    component.setWorkBufferModifier({ glsl: shaderGLSL, wgsl: shaderWGSL });
  }

  setClipState(
    enabled: boolean,
    min: pc.Vec3,
    max: pc.Vec3,
    boxEnabled: boolean,
    worldToBox: pc.Mat4,
    originSides: pc.Vec3,
    worldToOrigin: pc.Mat4,
    force = false,
  ): boolean {
    const next: ClipValues = {
      enabled: enabled ? 1 : 0,
      boxEnabled: boxEnabled ? 1 : 0,
      min: new Float32Array([min.x, min.y, min.z]),
      max: new Float32Array([max.x, max.y, max.z]),
      worldToBox: new Float32Array(worldToBox.data),
      originSides: new Float32Array([originSides.x, originSides.y, originSides.z]),
      worldToOrigin: new Float32Array(worldToOrigin.data),
    };
    const unchanged = this.applied
      && this.applied.enabled === next.enabled
      && this.applied.boxEnabled === next.boxEnabled
      && arraysEqual(this.applied.min, next.min)
      && arraysEqual(this.applied.max, next.max)
      && arraysEqual(this.applied.worldToBox, next.worldToBox)
      && arraysEqual(this.applied.originSides, next.originSides)
      && arraysEqual(this.applied.worldToOrigin, next.worldToOrigin);
    if (unchanged) return false;

    const now = performance.now();
    if (!force && now - this.lastAppliedAt < UPDATE_INTERVAL_MS) return false;
    this.component.setParameter('uClipEnabled', next.enabled);
    this.component.setParameter('uClipMin', next.min);
    this.component.setParameter('uClipMax', next.max);
    this.component.setParameter('uClipBoxEnabled', next.boxEnabled);
    this.component.setParameter('uClipWorldToBox', next.worldToBox);
    this.component.setParameter('uOriginClipSides', next.originSides);
    this.component.setParameter('uClipWorldToOrigin', next.worldToOrigin);
    this.applied = next;
    this.lastAppliedAt = now;
    return true;
  }
}
