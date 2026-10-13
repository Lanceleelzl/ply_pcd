import * as pc from 'playcanvas';
import type { Region } from '../../api/merge-api';

const glsl = /* glsl */`
uniform sampler2D uMergeRegionData;
uniform float uMergeTextureWidth;
uniform float uMergeRegionCount;

vec4 mergeRegionTexel(int index) {
    int width = int(uMergeTextureWidth);
    return texelFetch(uMergeRegionData, ivec2(index % width, index / width), 0);
}

void modifySplatCenter(inout vec3 center) {}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    vec2 point = modifiedCenter.xy;
    int cursor = 0;
    for (int region = 0; region < int(uMergeRegionCount); region++) {
        vec4 header = mergeRegionTexel(cursor);
        int count = int(header.x);
        int action = int(header.y);
        vec4 bounds = mergeRegionTexel(cursor + 1);
        int first = cursor + 2;
        cursor = first + count;
        bool inBounds = point.x >= bounds.x && point.x <= bounds.y && point.y >= bounds.z && point.y <= bounds.w;
        if (!inBounds) {
            if (action == 2) { scale = vec3(0.0); return; }
            continue;
        }
        bool inside = false;
        vec2 previous = mergeRegionTexel(first + count - 1).xy;
        for (int vertex = 0; vertex < count; vertex++) {
            vec2 current = mergeRegionTexel(first + vertex).xy;
            float cross = (current.x - previous.x) * (point.y - previous.y)
                - (current.y - previous.y) * (point.x - previous.x);
            if (abs(cross) <= 0.000001 &&
                point.x >= min(previous.x, current.x) && point.x <= max(previous.x, current.x) &&
                point.y >= min(previous.y, current.y) && point.y <= max(previous.y, current.y)) {
                inside = true;
                break;
            }
            if ((previous.y > point.y) != (current.y > point.y) &&
                point.x < (current.x - previous.x) * (point.y - previous.y) / (current.y - previous.y) + previous.x)
                inside = !inside;
            previous = current;
        }
        if ((action == 1 && inside) || (action == 2 && !inside)) { scale = vec3(0.0); return; }
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {}
`;

const wgsl = /* wgsl */`
var uMergeRegionData: texture_2d<f32>;
uniform uMergeTextureWidth: f32;
uniform uMergeRegionCount: f32;

fn mergeRegionTexel(index: i32) -> vec4f {
    let width = i32(uniform.uMergeTextureWidth);
    return textureLoad(uMergeRegionData, vec2i(index % width, index / width), 0);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f,
    rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let point = modifiedCenter.xy;
    var cursor = 0;
    for (var region = 0; region < i32(uniform.uMergeRegionCount); region = region + 1) {
        let header = mergeRegionTexel(cursor);
        let count = i32(header.x);
        let action = i32(header.y);
        let bounds = mergeRegionTexel(cursor + 1);
        let first = cursor + 2;
        cursor = first + count;
        let inBounds = point.x >= bounds.x && point.x <= bounds.y && point.y >= bounds.z && point.y <= bounds.w;
        if (!inBounds) {
            if (action == 2) { *scale = vec3f(0.0); return; }
            continue;
        }
        var inside = false;
        var previous = mergeRegionTexel(first + count - 1).xy;
        for (var vertex = 0; vertex < count; vertex = vertex + 1) {
            let current = mergeRegionTexel(first + vertex).xy;
            let cross = (current.x - previous.x) * (point.y - previous.y)
                - (current.y - previous.y) * (point.x - previous.x);
            if (abs(cross) <= 0.000001 &&
                point.x >= min(previous.x, current.x) && point.x <= max(previous.x, current.x) &&
                point.y >= min(previous.y, current.y) && point.y <= max(previous.y, current.y)) {
                inside = true;
                break;
            }
            if ((previous.y > point.y) != (current.y > point.y) &&
                point.x < (current.x - previous.x) * (point.y - previous.y) / (current.y - previous.y) + previous.x)
                inside = !inside;
            previous = current;
        }
        if ((action == 1 && inside) || (action == 2 && !inside)) { *scale = vec3f(0.0); return; }
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {}
`;

export class MergeGaussianClip {
  private texture: pc.Texture | null = null;

  constructor(private readonly app: pc.Application, private readonly component: pc.GSplatComponent) {
    component.setWorkBufferModifier({ glsl, wgsl });
  }

  setRules(regions: Region[], model: number, enabled: boolean): void {
    const active = enabled ? regions.filter(region => region.actions[model] !== 'none') : [];
    const texels = Math.max(1, active.reduce((total, region) => total + region.polygon.length + 2, 0));
    const width = Math.min(1024, this.app.graphicsDevice.maxTextureSize);
    const height = Math.ceil(texels / width);
    const texture = new pc.Texture(this.app.graphicsDevice, {
      width, height, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false,
      minFilter: pc.FILTER_NEAREST, magFilter: pc.FILTER_NEAREST,
      addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    });
    const data = texture.lock() as Float32Array;
    let cursor = 0;
    for (const region of active) {
      const points = region.polygon;
      data.set([points.length, region.actions[model] === 'remove_inside' ? 1 : 2], cursor * 4);
      cursor++;
      data.set([Math.min(...points.map(point => point[0])), Math.max(...points.map(point => point[0])),
        Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[1]))], cursor * 4);
      cursor++;
      for (const point of points) { data.set(point, cursor * 4); cursor++; }
    }
    texture.unlock();
    this.component.setParameter('uMergeRegionData', texture);
    this.component.setParameter('uMergeTextureWidth', width);
    this.component.setParameter('uMergeRegionCount', active.length);
    this.texture?.destroy();
    this.texture = texture;
  }

  destroy(): void { this.texture?.destroy(); this.texture = null; }
}
