import { lccIndex } from '../../engine/modules/lcc-index';
import { readOrigin, type GeoOrigin } from './viewer-origin';
export interface ModelFile {
  url: string;
  filename: string;
}
export async function localModel(
  files: Map<string, Blob>,
  urls: string[],
  signal: AbortSignal,
  onOrigin: (origin: GeoOrigin) => void,
  onLocationMissing?: (reason: string) => void,
): Promise<ModelFile> {
  const paths = [...files.keys()];
  const basename = (p: string) => p.split('/').pop()!;
  const indexes = paths.filter((p) => /^(lod-meta\.json|.*\.lcc2?)$/i.test(basename(p)));
  const metas = paths.filter((p) => basename(p) === 'meta.json');
  const entry = indexes[0] ?? (metas.length === 1 ? metas[0] : paths.length === 1 ? paths[0] : undefined);
  if (indexes.length > 1) throw new Error('目录含多个模型入口，请选择单个模型目录');
  if (!entry) throw new Error('未找到模型索引。独立 PLY 请通过「加载模型 → 选择文件」打开所需文件。');
  let origin = await readOrigin(new Map([[entry, files.get(entry)!]]));
  if (!origin && basename(entry) === 'lod-meta.json') {
    const parent = entry.slice(0, -'lod-meta.json'.length);
    const sidecar = files.get(parent + 'coordinate-manifest.json');
    try {
      if (!sidecar) throw Error('流式索引未记录地理原点');
      const manifest = JSON.parse(await sidecar.text());
      const index = JSON.parse(await files.get(entry)!.text());
      if (manifest.schema_version !== 1 || manifest.result_format !== 'streamed_sog' ||
          !Array.isArray(manifest.levels) || !manifest.levels.length || manifest.levels.length !== index.lodLevels)
        throw Error('坐标说明与流式索引不匹配');
      const cache = files.get(parent + 'cache-manifest.json');
      if (!cache) throw Error('坐标说明缺少校验清单');
      const records = JSON.parse(await cache.text()).files;
      const entries = [...files.keys()].filter(p => p.startsWith(parent) && p !== parent + 'cache-manifest.json');
      if (!Array.isArray(records) || records.length !== entries.length ||
          new Set(records.map(r => parent + r.path)).size !== records.length)
        throw Error('流式校验清单不完整');
      for (const record of records) {
        const file = files.get(parent + record.path);
        if (!file || file === cache || file.size !== record.bytes) throw Error('流式数据与清单不匹配');
        const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        signal.throwIfAborted();
        if (Array.from(new Uint8Array(hash), v => v.toString(16).padStart(2,'0')).join('') !== record.sha256)
          throw Error('流式数据校验失败');
      }
      let shared: GeoOrigin | undefined;
      const counts = Array<number>(index.lodLevels).fill(0);
      const nodes = [index.tree];
      while (nodes.length) {
        const node = nodes.pop();
        nodes.push(...(node.children ?? []));
        for (const [lod, info] of Object.entries(node.lods ?? {}))
          counts[Number(lod)] += (info as {count: number}).count;
      }
      for (const [i, level] of manifest.levels.entries()) {
        const hints = level.result_ply_coordinate_hints;
        const triple = (v: unknown): v is Array<number|string> => Array.isArray(v) && v.length === 3 &&
          v.every(n => (typeof n === 'number' || typeof n === 'string' && n.trim()) && Number.isFinite(Number(n)));
        if (level.streamed_lod !== i || level.result_gaussians !== counts[i] || !['source','embedded'].includes(level.coordinate_mode) ||
            !Number.isInteger(Number(hints?.epsg)) || !triple(hints?.offset) ||
            !triple(hints.shift) || !hints.shift.every((n: unknown) => Number(n) === 0) ||
            !triple(hints.scale) || !hints.scale.every((n: unknown) => Number(n) === 1))
          throw Error('坐标说明中存在无法还原的层级');
        const value = {epsg: Number(hints.epsg), offset: hints.offset.map(Number) as GeoOrigin['offset']};
        if (shared && (shared.epsg !== value.epsg || shared.offset.some((n,j) => n !== value.offset[j])))
          throw Error('各 LOD 层的地理原点不一致');
        shared = value;
      }
      origin = shared;
    } catch (error) { signal.throwIfAborted(); onLocationMissing?.(String(error)); }
  }
  if (origin) onOrigin(origin);
  const makeUrl = (blob: Blob, path: string) => {
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return url + '#/' + encodeURIComponent(basename(path));
  };
  if (/\.lcc$/i.test(entry)) {
    const manifest = await lccIndex(files, entry, signal);
    return { filename: 'lod-meta.json', url: makeUrl(new Blob([JSON.stringify(manifest)]), 'lod-meta.json') };
  }
  if (/\.(zip|spz)$/i.test(entry)) {
    const converted = await new Promise<Map<string, Blob>>((resolve, reject) => {
      signal.throwIfAborted();
      const worker = new Worker(new URL('./local-convert.worker.ts', import.meta.url), { type: 'module' });
      const finish = () => {
        worker.terminate();
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        finish();
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data.files);
      };
      worker.onerror = (event) => {
        finish();
        reject(new Error(event.message));
      };
      worker.postMessage({ files, entry });
    });
    return localModel(converted, urls, signal, onOrigin, onLocationMissing);
  }
  const references = new Map<string, Promise<string>>();
  function resource(path: string): Promise<string> {
    const cached = references.get(path);
    if (cached) return cached;
    const value = resolve(path);
    references.set(path, value);
    return value;
  }
  async function resolve(path: string): Promise<string> {
    const blob = files.get(path);
    if (!blob) throw new Error('缺少本地资源：' + path);
    if (!/\.(json|lcc2)$/i.test(path)) return makeUrl(blob, path);
    const meta = JSON.parse(await blob.text());
    const child = (name: string, accepted: RegExp) => {
      if (!name || name.includes(':') || name.startsWith('/') || name.split(/[\\/]/).includes('..'))
        throw new Error('无效的资源路径');
      if (!accepted.test(name)) throw new Error('不支持的资源类型：' + name);
      const next = path.slice(0, path.lastIndexOf('/') + 1) + name.replace(/^\.\//, '');
      if (next === path) throw new Error('索引引用自身');
      return resource(next);
    };
    if (basename(path) === 'lod-meta.json') {
      meta.filenames = await Promise.all(
        meta.filenames.map((name: string) => child(name, /(?:^|\/)meta\.json$|\.sog$/i)),
      );
      if (meta.environment) meta.environment = await child(meta.environment, /(?:^|\/)meta\.json$|\.sog$/i);
    } else if (/\.lcc2$/i.test(path)) {
      meta.root.splatFiles = await Promise.all(
        meta.root.splatFiles.map((name: string) => child(name, /\.(sog|ply)$/i)),
      );
    } else {
      for (const item of [meta.means, meta.scales, meta.quats, meta.sh0, meta.shN, ...(meta.blind ?? [])]) {
        if (item?.files)
          item.files = await Promise.all(item.files.map((name: string) => child(name, /\.webp$/i)));
      }
    }
    return makeUrl(new Blob([JSON.stringify(meta)], { type: 'application/json' }), path);
  }
  return { filename: basename(entry), url: await resource(entry) };
}
