import * as pc from 'playcanvas';
import type { XYZ } from '../../coordinate-math';
import type { EditorRule } from '../../api/gaussian-editor-api';
import { GaussianClipController, shaderGLSL, shaderWGSL } from '../../gaussian-clipping';

const glslRules = /* glsl */`
uniform sampler2D uEditorRuleData;
uniform float uEditorRuleWidth;
uniform float uEditorRuleCount;

vec4 editorTexel(int index) {
    int width = int(uEditorRuleWidth);
    return texelFetch(uEditorRuleData, ivec2(index % width, index / width), 0);
}

bool editorContains(int kind, int first, int count, vec3 point) {
    if (kind == 1) {
        vec4 bounds = editorTexel(first);
        if (point.x < bounds.x || point.x > bounds.y || point.y < bounds.z || point.y > bounds.w) return false;
        bool inside = false;
        vec2 previous = editorTexel(first + count).xy;
        for (int vertex = 0; vertex < count; vertex++) {
            vec2 current = editorTexel(first + 1 + vertex).xy;
            float crossValue = (point.x - previous.x) * (current.y - previous.y)
                - (point.y - previous.y) * (current.x - previous.x);
            if (abs(crossValue) <= 0.000001 && point.x >= min(previous.x, current.x)
                && point.x <= max(previous.x, current.x) && point.y >= min(previous.y, current.y)
                && point.y <= max(previous.y, current.y)) return true;
            if ((previous.y > point.y) != (current.y > point.y)
                && point.x < (current.x - previous.x) * (point.y - previous.y) / (current.y - previous.y) + previous.x)
                inside = !inside;
            previous = current;
        }
        return inside;
    }
    vec4 center = editorTexel(first);
    vec3 offset = point - center.xyz;
    if (kind == 2) return dot(offset, offset) <= center.w * center.w;
    vec3 size = editorTexel(first + 1).xyz;
    vec4 rotation = editorTexel(first + 2);
    vec3 q = -rotation.yzw;
    vec3 t = 2.0 * cross(q, offset);
    vec3 local = offset + rotation.x * t + cross(q, t);
    return all(lessThanEqual(abs(local), size * 0.5));
}

bool editorKeeps(vec3 point) {
    bool hasKeep = false;
    bool matchedKeep = false;
    bool removed = false;
    int cursor = 0;
    for (int index = 0; index < int(uEditorRuleCount); index++) {
        vec4 header = editorTexel(cursor);
        int kind = int(header.x), action = int(header.y), count = int(header.z);
        int first = cursor + 1;
        cursor = first + (kind == 1 ? count + 1 : kind == 2 ? 1 : 3);
        bool inside = editorContains(kind, first, count, point);
        if (action == 1) { hasKeep = true; matchedKeep = matchedKeep || inside; }
        else removed = removed || inside;
    }
    return (!hasKeep || matchedKeep) && !removed;
}
`;

const wgslRules = /* wgsl */`
var uEditorRuleData: texture_2d<f32>;
uniform uEditorRuleWidth: f32;
uniform uEditorRuleCount: f32;

fn editorTexel(index: i32) -> vec4f {
    let width = i32(uniform.uEditorRuleWidth);
    return textureLoad(uEditorRuleData, vec2i(index % width, index / width), 0);
}

fn editorContains(kind: i32, first: i32, count: i32, point: vec3f) -> bool {
    if (kind == 1) {
        let bounds = editorTexel(first);
        if (point.x < bounds.x || point.x > bounds.y || point.y < bounds.z || point.y > bounds.w) { return false; }
        var inside = false;
        var previous = editorTexel(first + count).xy;
        for (var vertex = 0; vertex < count; vertex = vertex + 1) {
            let current = editorTexel(first + 1 + vertex).xy;
            let crossValue = (point.x - previous.x) * (current.y - previous.y)
                - (point.y - previous.y) * (current.x - previous.x);
            if (abs(crossValue) <= 0.000001 && point.x >= min(previous.x, current.x)
                && point.x <= max(previous.x, current.x) && point.y >= min(previous.y, current.y)
                && point.y <= max(previous.y, current.y)) { return true; }
            if ((previous.y > point.y) != (current.y > point.y)
                && point.x < (current.x - previous.x) * (point.y - previous.y) / (current.y - previous.y) + previous.x) {
                inside = !inside;
            }
            previous = current;
        }
        return inside;
    }
    let center = editorTexel(first);
    let offset = point - center.xyz;
    if (kind == 2) { return dot(offset, offset) <= center.w * center.w; }
    let size = editorTexel(first + 1).xyz;
    let rotation = editorTexel(first + 2);
    let q = -rotation.yzw;
    let t = 2.0 * cross(q, offset);
    let local = offset + rotation.x * t + cross(q, t);
    return all(abs(local) <= size * 0.5);
}

fn editorKeeps(point: vec3f) -> bool {
    var hasKeep = false;
    var matchedKeep = false;
    var removed = false;
    var cursor = 0;
    for (var index = 0; index < i32(uniform.uEditorRuleCount); index = index + 1) {
        let header = editorTexel(cursor);
        let kind = i32(header.x);
        let action = i32(header.y);
        let count = i32(header.z);
        let first = cursor + 1;
        cursor = first + select(select(3, 1, kind == 2), count + 1, kind == 1);
        let inside = editorContains(kind, first, count, point);
        if (action == 1) { hasKeep = true; matchedKeep = matchedKeep || inside; }
        else { removed = removed || inside; }
    }
    return (!hasKeep || matchedKeep) && !removed;
}
`;

const glslMarker = 'void modifySplatCenter(inout vec3 center) {}';
const wgslMarker = 'fn modifySplatCenter(center: ptr<function, vec3f>) {}';
const glslCondition = '|| !insideOrigin)';
const wgslCondition = '|| !insideOrigin)';
if (!shaderGLSL.includes(glslMarker) || !shaderWGSL.includes(wgslMarker)
  || !shaderGLSL.includes(glslCondition) || !shaderWGSL.includes(wgslCondition))
  throw new Error('高斯编辑裁剪着色器与基础剖切着色器不兼容');
const editorModifier = {
  glsl: shaderGLSL.replace(glslMarker, `${glslRules}\n${glslMarker}`)
    .replace(glslCondition, '|| !insideOrigin || !editorKeeps(modifiedCenter))'),
  wgsl: shaderWGSL.replace(wgslMarker, `${wgslRules}\n${wgslMarker}`)
    .replace(wgslCondition, '|| !insideOrigin || !editorKeeps(modifiedCenter))'),
};

export class EditorGaussianClip extends GaussianClipController {
  private texture: pc.Texture | null = null;

  constructor(private readonly app: pc.Application, private readonly editorComponent: pc.GSplatComponent) {
    super(editorComponent, editorModifier);
  }

  setRules(rules: EditorRule[], origin: XYZ): void {
    const texels = Math.max(1, rules.reduce((total, rule) => total + (rule.type === 'polygon'
      ? rule.points.length + 2 : rule.type === 'sphere' ? 2 : 4), 0));
    const width = Math.min(1024, this.app.graphicsDevice.maxTextureSize);
    const texture = new pc.Texture(this.app.graphicsDevice, {
      width, height: Math.ceil(texels / width), format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
      minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    const data = texture.lock() as Float32Array;
    let cursor = 0;
    for (const rule of rules) {
      const kind = rule.type === 'polygon' ? 1 : rule.type === 'sphere' ? 2 : 3;
      data.set([kind, rule.action === 'keep' ? 1 : 2, rule.type === 'polygon' ? rule.points.length : 0, 0], cursor++ * 4);
      if (rule.type === 'polygon') {
        const points = rule.points.map(([x, y]) => [x - origin[0], y - origin[1]]);
        data.set([Math.min(...points.map(point => point[0])), Math.max(...points.map(point => point[0])),
          Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[1]))], cursor++ * 4);
        for (const point of points) data.set(point, cursor++ * 4);
      } else if (rule.type === 'sphere') {
        data.set([...rule.center.map((value, axis) => value - origin[axis]), rule.radius], cursor++ * 4);
      } else {
        data.set([...rule.center.map((value, axis) => value - origin[axis]), 0], cursor++ * 4);
        data.set([...rule.size, 0], cursor++ * 4);
        data.set(rule.rotation, cursor++ * 4);
      }
    }
    texture.unlock();
    this.editorComponent.setParameter('uEditorRuleData', texture);
    this.editorComponent.setParameter('uEditorRuleWidth', width);
    this.editorComponent.setParameter('uEditorRuleCount', rules.length);
    this.texture?.destroy();
    this.texture = texture;
  }

  destroy(): void { this.texture?.destroy(); this.texture = null; }
}
