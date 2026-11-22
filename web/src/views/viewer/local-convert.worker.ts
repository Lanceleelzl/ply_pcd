import {
  createChunkDataPool,
  getInputFormat,
  MemoryFileSystem,
  readFile,
  WebPCodec,
  writeSource,
  ZipReadFileSystem,
} from '@playcanvas/splat-transform';
import wasm from '@playcanvas/splat-transform/lib/webp.wasm?url';
import { blobSource } from './blob-source';

self.onmessage = async ({ data }: MessageEvent<{ files: Map<string, Blob>; entry: string }>) => {
  try {
    const { files, entry } = data;
    if (/\.zip$/i.test(entry)) {
      const zip = new ZipReadFileSystem(blobSource(files.get(entry)!));
      const result = new Map<string, Blob>();
      try {
        for (const path of await zip.list()) {
          if (path.endsWith('/')) continue;
          const header = await zip.getEntry(path);
          if (header?.method === 0) {
            const archive = files.get(entry)!;
            const record = new DataView(
              await archive.slice(header.offset, header.offset + 30).arrayBuffer(),
            );
            if (record.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP 文件头无效');
            const start = header.offset + 30 + record.getUint16(26, true) + record.getUint16(28, true);
            result.set(path, archive.slice(start, start + header.uncompressedSize));
            continue;
          }
          const source = await zip.createSource(path);
          try {
            result.set(path, new Blob([new Uint8Array(await source.read().readAll())]));
          } finally {
            source.close();
          }
        }
      } finally {
        zip.close();
      }
      self.postMessage({ files: result });
      return;
    }
    WebPCodec.wasmUrl = wasm;
    const sources = await readFile({
      filename: entry,
      inputFormat: getInputFormat(entry),
      fileSystem: {
        async createSource(name) {
          const blob = files.get(name);
          if (!blob) throw new Error('缺少模型文件：' + name);
          return blobSource(blob);
        },
      },
    });
    const pool = createChunkDataPool({ chunkSize: sources[0].meta.chunkSize });
    const output = new MemoryFileSystem();
    try {
      await writeSource(
        { filename: 'model.ply', outputFormat: 'ply', source: sources[0], pool, options: {} },
        output,
      );
      const result = new Map<string, Blob>();
      for (const [path, bytes] of output.results) result.set(path, new Blob([new Uint8Array(bytes)]));
      self.postMessage({ files: result });
    } finally {
      pool.destroy();
      for (const source of sources) await source.close();
    }
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
