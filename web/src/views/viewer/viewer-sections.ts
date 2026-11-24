import * as pc from 'playcanvas';
import type { TransformParameters } from '../../coordinate-math';

export interface ViewerSection {
  id: number;
  axis: 'x' | 'y' | 'z' | 'box';
  cut: number;
  positive: boolean;
  enabled: boolean;
  boundary: boolean;
  box: TransformParameters;
}

function boxMatrix(box: TransformParameters) {
  return new pc.Mat4().setTRS(new pc.Vec3(...box.translation),
    new pc.Quat().setFromEulerAngles(...box.rotation_degrees), new pc.Vec3(...box.scale));
}

export function boundaryLines(rule: ViewerSection) {
  const matrix = boxMatrix(rule.box);
  if (rule.axis !== 'box') {
    const center = new pc.Vec3(...rule.box.translation);
    center[rule.axis] = rule.cut;
    matrix.setTRS(center, pc.Quat.IDENTITY, new pc.Vec3(...rule.box.scale));
  }
  const corners = Array.from({ length: 8 }, (_, i) => {
    const p = new pc.Vec3((i & 1) - .5, ((i >> 1) & 1) - .5, ((i >> 2) & 1) - .5);
    if (rule.axis !== 'box') p[rule.axis] = 0;
    return matrix.transformPoint(p);
  });
  const lines: pc.Vec3[] = [];
  const skip = { x: 1, y: 2, z: 4, box: 0 }[rule.axis];
  corners.forEach((corner, i) => {
    if (i & skip) return;
    for (const bit of [1,2,4]) if (bit !== skip && !(i & bit)) lines.push(corner, corners[i | bit]);
  });
  return lines;
}

// Each group's enabled rules intersect. Visible coincident copies share one union.
export function clipProgram(groups: ViewerSection[][]) {
  const matrices: Float32Array[] = [];
  const active = groups.map(group => group.filter(rule => rule.enabled));
  const tests = active.some(group => !group.length) ? [] : active.map(group => group.map(rule => {
    const matrix = rule.axis === 'box' ? boxMatrix(rule.box).invert() : new pc.Mat4();
    if (rule.axis !== 'box') matrix.data[12 + 'xyz'.indexOf(rule.axis)] = -rule.cut;
    const index = matrices.push(matrix.data) - 1;
    return { rule, index };
  }));
  function source(wgsl: boolean) {
    const declarations = matrices.map((_,i) => wgsl ? `uniform vClip${i}: mat4x4f;` : `uniform mat4 vClip${i};`).join('\n');
    const expression = tests.map(group => '(' + group.map(({rule,index}) => {
      const point = `(${wgsl?'uniform.':''}vClip${index} * ${wgsl?'vec4f':'vec4'}(p,1.0))`;
      if (rule.axis !== 'box') return point + '.' + rule.axis + (rule.positive ? ' >= 0.0' : ' <= 0.0');
      return wgsl ? `all(abs(${point}.xyz) <= vec3f(0.5))` : `all(lessThanEqual(abs(${point}.xyz),vec3(0.5)))`;
    }).join(' && ') + ')').join(' || ') || 'true';
    return declarations + '\n' + (wgsl ? 'fn viewerInside(p:vec3f) -> bool' : 'bool viewerInside(vec3 p)') + ' { return ' + expression + '; }';
  }
  return { matrices, glsl: source(false), wgsl: source(true) };
}

const signatures = new WeakMap<pc.GSplatComponent | pc.ShaderMaterial,string>();
const pointShaders = new WeakMap<pc.ShaderMaterial,NonNullable<pc.ShaderMaterial['shaderDesc']>>();
export function applySections(target: pc.GSplatComponent | pc.ShaderMaterial, groups: ViewerSection[][]) {
  const program = clipProgram(groups);
  if (signatures.get(target) !== program.glsl) {
    if (target instanceof pc.ShaderMaterial) {
      const base = pointShaders.get(target) ?? target.shaderDesc!;
      pointShaders.set(target,base);
      target.shaderDesc = {...base,
        fragmentGLSL: base.fragmentGLSL!.replace('void main(void) {', program.glsl + '\nvoid main(void) { if (!viewerInside(vWorldPosition)) discard;')};
    } else {
      target.setWorkBufferModifier({
        glsl: program.glsl + '\nvoid modifySplatCenter(inout vec3 p) {}\nvoid modifySplatColor(vec3 p,inout vec4 c) { if (!viewerInside(p)) c.a=0.0; }\nvoid modifySplatRotationScale(vec3 a,vec3 p,inout vec4 r,inout vec3 s) { if (!viewerInside(p)) s=vec3(0.0); }',
        wgsl: program.wgsl + '\nfn modifySplatCenter(p:ptr<function,vec3f>) {}\nfn modifySplatColor(p:vec3f,c:ptr<function,vec4f>) { if (!viewerInside(p)) { (*c).a=0.0; } }\nfn modifySplatRotationScale(a:vec3f,p:vec3f,r:ptr<function,vec4f>,s:ptr<function,vec3f>) { if (!viewerInside(p)) { *s=vec3f(0.0); } }'
      });
    }
    signatures.set(target, program.glsl);
  }
  program.matrices.forEach((data,i) => target.setParameter('vClip'+i,data));
}
