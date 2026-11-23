import { Vec3 } from 'playcanvas';
import type { XYZ } from '../../coordinate-math';
import type { GeoOrigin } from './viewer-origin';

// Bound GPU memory for a single-file preview while sampling across the entire survey.
const previewLimit = 2_000_000;
const recordLengths = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];

export function projectedWkt(wkt:string) {
  if (!/^(?:PROJCS|PROJCRS)\s*\[/i.test(wkt)) return;
  const authority = wkt.match(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]$/i);
  if (authority) return Number(authority[1]);
  const utm = wkt.match(/^\w+\s*\[\s*"WGS 84 \/ UTM zone (\d{1,2})([NS])"/i);
  if (utm && +utm[1] >= 1 && +utm[1] <= 60) return (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + Number(utm[1]);
}

export async function projectedCrs(file: {slice:(start:number,end:number)=>Pick<Blob,'arrayBuffer'|'text'>}, start: number, end: number, records: number) {
  const decoder = new TextDecoder();
  for (let i = 0; i < records; i++) {
    if (start + 54 > end) throw Error('LAS 坐标记录头不完整');
    const header = new DataView(await file.slice(start, start + 54).arrayBuffer());
    const user = decoder.decode(new Uint8Array(header.buffer, 2, 16)).split('\0')[0];
    const id = header.getUint16(18, true), size = header.getUint16(20, true);
    start += 54;
    if (start + size > end) throw Error('LAS 坐标记录长度无效');
    if (user === 'LASF_Projection' && id === 34735) {
      const keys = new DataView(await file.slice(start, start + size).arrayBuffer());
      for (let j = 8; j + 8 <= size; j += 8) {
        const code = keys.getUint16(j + 6, true);
        if (keys.getUint16(j, true) === 3072 && keys.getUint16(j + 2, true) === 0 && code > 0 && code < 32767) return code;
      }
    }
    if (user === 'LASF_Projection' && id === 2112) {
      const wkt = (await file.slice(start, start + size).text()).replace(/\0/g, '').trim();
      const epsg=projectedWkt(wkt);
      if (epsg) return epsg;
    }
    start += size;
  }
}

export async function readLocalLas(file: Blob, signal: AbortSignal, full = false) {
  const h = new DataView(await file.slice(0, 375).arrayBuffer());
  if (h.byteLength < 227 || h.getUint32(0) !== 0x4c415346 || h.getUint8(24) !== 1) throw Error('无效或不支持的 LAS 文件头');
  const format = h.getUint8(104), recordSize = h.getUint16(105, true);
  if (format & 0xc0) throw Error('本地浏览暂不支持 LAZ 压缩点记录');
  if (format >= recordLengths.length || recordSize < recordLengths[format]) throw Error('不支持的 LAS 点记录格式');
  const start = h.getUint32(96, true), headerSize = h.getUint16(94, true);
  const extended = h.getUint8(25) >= 4 && headerSize >= 375 && h.byteLength >= 375 ? Number(h.getBigUint64(247, true)) : 0;
  const total = extended || h.getUint32(107, true);
  if (!total || headerSize < 227 || start < headerSize || total > Math.floor((file.size - start) / recordSize)) throw Error('LAS 点数或数据长度无效');
  const axes = [0, 1, 2];
  const scale = axes.map(i => h.getFloat64(131 + i * 8, true));
  const offset = axes.map(i => h.getFloat64(155 + i * 8, true));
  const min = axes.map(i => h.getFloat64(187 + i * 16, true));
  const max = axes.map(i => h.getFloat64(179 + i * 16, true));
  if (axes.some(i => ![scale[i], offset[i], min[i], max[i]].every(Number.isFinite) || scale[i] <= 0 || max[i] < min[i])) throw Error('LAS 坐标范围无效');
  const center = axes.map(i => (min[i] + max[i]) / 2) as XYZ;
  const epsg = await projectedCrs(file, headerSize, start, h.getUint32(100, true));
  const origin: GeoOrigin | undefined = epsg ? {epsg, offset: center} : undefined;
  const count = full ? total : Math.min(total, previewLimit), positions = new Float32Array(count * 3);
  const rgbOffset = format === 2 ? 20 : [3, 5].includes(format) ? 28 : [7, 8, 10].includes(format) ? 30 : undefined;
  const rgb = rgbOffset === undefined ? undefined : new Uint16Array(count * 3);
  let maxColor = 0;
  const chunkSize = Math.max(1, Math.floor(4 * 1024 * 1024 / recordSize));
  for (let first = 0, point = 0; first < total; first += chunkSize) {
    signal.throwIfAborted();
    const end = Math.min(first + chunkSize, total);
    const data = new DataView(await file.slice(start + first * recordSize, start + end * recordSize).arrayBuffer());
    for (; point < count; point++) {
      const source = Math.floor(point * (total / count));
      if (source >= end) break;
      const record = (source - first) * recordSize;
      for (let i = 0; i < 3; i++) positions[point * 3 + i] = data.getInt32(record + i * 4, true) * scale[i] + (offset[i] - center[i]);
      if (rgb && rgbOffset !== undefined) {
        for (let i = 0; i < 3; i++) {
          const channel = data.getUint16(record + rgbOffset + i * 2, true);
          rgb[point * 3 + i] = channel;
          maxColor = Math.max(maxColor, channel);
        }
      }
    }
  }
  signal.throwIfAborted();
  const colors = rgb ? new Uint8Array(count * 4) : undefined;
  if (colors && rgb) {
    // Some exporters store 8-bit RGB directly in the 16-bit LAS fields.
    const shift = maxColor > 255 ? 8 : 0;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 3; j++) colors[i * 4 + j] = rgb[i * 3 + j] >> shift;
      colors[i * 4 + 3] = 255;
    }
  }
  return {total, origin, cloud: {positions, colors, count, min: new Vec3(min[0]-center[0], min[1]-center[1], min[2]-center[2]),
    max: new Vec3(max[0]-center[0], max[1]-center[1], max[2]-center[2])}};
}
