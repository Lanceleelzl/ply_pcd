import { unzlibSync } from 'fflate';

// elv_c uses a geographic grid with twice as many columns as rows.
export async function tiandituHeights(points: number[][], zoom: number, key: string, signal: AbortSignal) {
  const level = Math.max(6, Math.min(12, zoom));
  const columns = 2 ** level, rows = columns / 2;
  const tiles = new Map<string, Promise<DataView>>();
  return Promise.all(points.map(async ([lon, lat]) => {
    const u = (lon + 180) / 360 * columns, v = (90 - lat) / 180 * rows;
    const x = Math.min(columns - 1, Math.floor(u)), y = Math.min(rows - 1, Math.floor(v));
    const id = x + '/' + y;
    let tile = tiles.get(id);
    if (!tile) {
      const params = new URLSearchParams({T:'elv_c', x:String(x), y:String(y), l:String(level), tk:key});
      tile = fetch('https://t0.tianditu.gov.cn/mapservice/swdx?' + params, {signal}).then(async response => {
        if (!response.ok) throw Error('天地图 DEM 请求失败，请检查服务授权');
        const data = unzlibSync(new Uint8Array(await response.arrayBuffer()));
        if (![45000,90000].includes(data.byteLength)) throw Error('天地图 DEM 瓦片格式异常');
        return new DataView(data.buffer,data.byteOffset,data.byteLength);
      });
      tiles.set(id,tile);
    }
    const data = await tile;
    const pixel = Math.round((v-y)*149)*150 + Math.round((u-x)*149);
    const h = data.byteLength===45000 ? data.getInt16(pixel*2,true) : data.getFloat32(pixel*4,true);
    return Number.isFinite(h) && h>=-2000 && h<=10000 ? h : undefined;
  }));
}
