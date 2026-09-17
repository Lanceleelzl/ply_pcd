import * as pc from 'playcanvas';
import webpWasmUrl from '@playcanvas/splat-transform/lib/webp.wasm?url';

const MAX_SPLATS = 20_000_000;

function selectLodIndex(counts: readonly number[]): number {
  const candidates = counts.map((count, index) => ({ count, index }));
  const under = candidates.filter(item => item.count < MAX_SPLATS);
  return (under.length > 0
    ? under.reduce((best, item) => item.count > best.count ? item : best)
    : candidates.reduce((best, item) => item.count < best.count ? item : best)).index;
}

export async function loadDirectGaussian(
  app: pc.Application,
  url: string,
  filename: string,
): Promise<{ asset: pc.Asset; transform: { translation: pc.Vec3; rotation: pc.Quat; scale: number } }> {
  const splat = await import('@playcanvas/splat-transform');
  splat.WebPCodec.wasmUrl = webpWasmUrl;
  const slash = url.lastIndexOf('/');
  const baseUrl = new URL(url.slice(0, slash + 1), window.location.href).href;
  const fileSystem = new splat.UrlReadFileSystem(baseUrl);
  const sources = await splat.readFile({
    filename: url.slice(slash + 1),
    inputFormat: splat.getInputFormat(filename),
    fileSystem,
  });
  const root = sources[0];
  for (const source of sources.slice(1)) await source.close();
  const source = root.meta.numLods > 1 ? splat.selectLod(root, selectLodIndex(root.meta.lodCounts)) : root;
  const pool = splat.createChunkDataPool({ chunkSize: source.meta.chunkSize });
  try {
    const table = await splat.materializeToDataTable(source, pool);
    const properties = table.columns.map(column => ({
      type: column.dataType ?? 'float32',
      name: column.name,
      storage: column.data,
      byteSize: column.data.BYTES_PER_ELEMENT,
    }));
    const data = new pc.GSplatData([{ name: 'vertex', count: table.numRows, properties }]);
    const asset = new pc.Asset(filename, 'gsplat');
    asset.resource = new pc.GSplatResource(app.graphicsDevice, data);
    asset.loaded = true;
    app.assets.add(asset);
    return { asset, transform: table.transform };
  } finally {
    pool.destroy();
    await root.close();
  }
}
