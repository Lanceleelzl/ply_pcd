type Bounds = { min: number[]; max: number[] };
type Node = {
  bound: Bounds;
  lods?: Record<string, { file: number; count: number; offset: number }>;
  children?: Node[];
};
type Block = { offset: number; count: number };
export interface TileProperty {
  name: string;
  storage: Float32Array;
  type: string;
  byteSize: number;
}
let sequence = 0;
const readers = new Map<
  string,
  (index: number) => Promise<{ count: number; properties: TileProperty[] }>
>();
export function readLocalTile(url: string) {
  const [id, index] = url.split('/').slice(-2);
  const read = readers.get(id);
  if (!read) throw new Error('本地图层已关闭');
  return read(parseInt(index, 10));
}

export async function lccIndex(files: Map<string, Blob>, entry: string, signal: AbortSignal) {
  const meta = JSON.parse(await files.get(entry)!.text());
  const prefix = entry.slice(0, entry.lastIndexOf('/') + 1);
  const data = files.get(prefix + 'data.bin'),
    index = files.get(prefix + 'index.bin');
  const sh = files.get(prefix + 'shcoef.bin');
  const environment = files.get(prefix + 'environment.bin');
  if (!index || !data) throw new Error('LCC 缺少 index.bin 或 data.bin');
  const levels = meta.totalLevel,
    stride = 4 + 16 * levels;
  if (!Number.isSafeInteger(levels) || levels < 1 || levels > 64 || index.size % stride)
    throw new Error('无效的 LCC 层级索引');
  const view = new DataView(await index.arrayBuffer());
  const id = String(++sequence);
  const blocks: Block[] = [],
    filenames: string[] = [],
    nodes: Node[] = [];
  for (let start = 0; start < view.byteLength; start += stride) {
    const x = view.getInt16(start, true),
      y = view.getInt16(start + 2, true);
    const low = meta.boundingBox.min,
      high = meta.boundingBox.max;
    const min = [low[0] + x * meta.cellLengthX, low[1] + y * meta.cellLengthY, low[2]];
    const node: Node = {
      bound: { min, max: [min[0] + meta.cellLengthX, min[1] + meta.cellLengthY, high[2]] },
      lods: {},
    };
    for (let level = 0; level < levels; level++) {
      const pos = start + 4 + 16 * level,
        count = view.getInt32(pos, true),
        offset = Number(view.getBigInt64(pos + 4, true));
      if (!count) continue;
      if (count < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset + count * 32 > data.size)
        throw new Error('LCC 分块越界');
      const file = blocks.length;
      blocks.push({ count, offset });
      filenames.push('/local-lcc/' + id + '/' + file + '.lcctile');
      node.lods![level] = { file, count, offset: 0 };
    }
    nodes.push(node);
  }
  function tree(items: Node[], axis = 0): Node {
    if (items.length === 1) return items[0];
    const sorted = items.sort((a, b) => a.bound.min[axis] - b.bound.min[axis]);
    const mid = Math.floor(sorted.length / 2);
    const children = [tree(sorted.slice(0, mid), 1 - axis), tree(sorted.slice(mid), 1 - axis)];
    return {
      children,
      bound: {
        min: [0, 1, 2].map((i) => Math.min(...children.map((c) => c.bound.min[i]))),
        max: [0, 1, 2].map((i) => Math.max(...children.map((c) => c.bound.max[i]))),
      },
    };
  }
  if (!nodes.length) throw new Error('LCC 索引为空');
  signal.throwIfAborted();
  const worker = new Worker(new URL('./lcc-tile.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<
    number,
    { ok: (v: { count: number; properties: TileProperty[] }) => void; fail: (e: Error) => void }
  >();
  let request = 0;
  worker.onmessage = ({ data: reply }) => {
    const job = pending.get(reply.request);
    pending.delete(reply.request);
    if (reply.error) job?.fail(new Error(reply.error));
    else job?.ok(reply.result);
  };
  const close = () => {
    worker.terminate();
    readers.delete(id);
    for (const job of pending.values()) job.fail(new Error('本地图层已关闭'));
    pending.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  worker.onerror = close;
  readers.set(
    id,
    (index) =>
      new Promise((ok, fail) => {
        const isEnvironment = index === blocks.length && !!environment;
        const block = isEnvironment ? { offset: blocks[0].offset, count: 1 } : blocks[index],
          key = ++request;
        pending.set(key, { ok, fail });
        worker.postMessage({
          request: key,
          meta,
          count: block.count,
          data: data.slice(block.offset, block.offset + block.count * 32),
          environment: isEnvironment ? environment : undefined,
          sh: sh?.slice(block.offset * 2, (block.offset + block.count * 32) * 2),
        });
      }),
  );
  return {
    lodLevels: levels,
    filenames,
    tree: tree(nodes),
    environment:
      environment?.size && blocks.length
        ? '/local-lcc/' + id + '/' + blocks.length + '.lcctile'
        : undefined,
  };
}
