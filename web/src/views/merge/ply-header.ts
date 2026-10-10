export type PlyHeader = {
  epsg: string;
  offset: [string, string, string];
  source: string;
  count: number;
  format: string;
  fields: string[];
  error?: string;
};

const required = ['x', 'y', 'z', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

export async function readPlyHeader(file: File): Promise<PlyHeader> {
  const result: PlyHeader = { epsg: '', offset: ['', '', ''], source: '', count: 0, format: '', fields: [] };
  let bytes = new Uint8Array(0);
  const decoder = new TextDecoder('ascii');
  for (let position = 0; position < Math.min(file.size, 1024 * 1024); position += 64 * 1024) {
    const chunk = new Uint8Array(await file.slice(position, position + 64 * 1024).arrayBuffer());
    const combined = new Uint8Array(bytes.length + chunk.length);
    combined.set(bytes); combined.set(chunk, bytes.length); bytes = combined;
    const text = decoder.decode(bytes);
    const match = /^end_header\r?\n/m.exec(text);
    if (!match) continue;
    const lines = text.slice(0, match.index).split(/\r?\n/);
    if (lines[0] !== 'ply') { result.error = '不是 PLY 文件'; return result; }
    const comments = new Map<string, string>();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'comment' && parts.length >= 3) comments.set(parts[1].toLowerCase(), parts.slice(2).join(' '));
      if (parts[0] === 'format') result.format = parts.slice(1).join(' ');
      if (parts[0] === 'element' && parts[1] === 'vertex') result.count = Number(parts[2]);
      if (parts[0] === 'property' && parts.length === 3) result.fields.push(parts[2]);
    }
    result.epsg = comments.get('epsg') ?? '';
    result.source = comments.get('source') ?? '';
    result.offset = ['x', 'y', 'z'].map(axis => comments.get(`offset${axis}`) ?? '') as [string, string, string];
    if (result.format !== 'binary_little_endian 1.0') result.error = '需要二进制小端 PLY';
    else if (!Number.isSafeInteger(result.count) || result.count <= 0) result.error = 'vertex 数量无效';
    else if (required.some(field => !result.fields.includes(field))) result.error = '缺少 Gaussian 必要属性';
    return result;
  }
  result.error = '未在前 1 MB 找到完整 PLY 文件头';
  return result;
}
