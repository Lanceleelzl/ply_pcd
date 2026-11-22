import {
  createChunkDataPool,
  materializeToDataTable,
  MemoryReadFileSystem,
  readFile,
} from '@playcanvas/splat-transform';
self.onmessage = async ({ data: job }) => {
  try {
    const fs = new MemoryReadFileSystem();
    if (job.environment) {
      const bytes = new Uint8Array(await job.environment.arrayBuffer());
      const stride = job.sh ? 96 : 32;
      if (bytes.length % stride) throw new Error('无效的 LCC 环境分块');
      job.count = bytes.length / stride;
      const records = new Uint8Array(job.count * 32),
        harmonics = new Uint8Array(job.count * (stride - 32));
      for (let i = 0; i < job.count; i++) {
        records.set(bytes.subarray(i * stride, i * stride + 32), i * 32);
        if (job.sh) harmonics.set(bytes.subarray(i * stride + 32, (i + 1) * stride), i * 64);
      }
      job.data = new Blob([records]);
      if (job.sh) job.sh = new Blob([harmonics]);
      for (const key of ['scale', 'shcoef']) {
        const env = job.meta.attributes.find((a: { name: string }) => a.name === 'env' + key);
        if (env)
          Object.assign(
            job.meta.attributes.find((a: { name: string }) => a.name === key),
            { min: env.min, max: env.max },
          );
      }
    }
    const index = new Uint8Array(20),
      view = new DataView(index.buffer);
    view.setInt32(4, job.count, true);
    view.setInt32(16, job.data.size, true);
    fs.set('index.bin', index);
    fs.set(
      'tile.lcc',
      new TextEncoder().encode(JSON.stringify({ ...job.meta, totalLevel: 1, splats: [job.count] })),
    );
    fs.set('data.bin', new Uint8Array(await job.data.arrayBuffer()));
    if (job.sh) fs.set('shcoef.bin', new Uint8Array(await job.sh.arrayBuffer()));
    const sources = await readFile({ filename: 'tile.lcc', inputFormat: 'lcc', fileSystem: fs });
    const pool = createChunkDataPool({ chunkSize: sources[0].meta.chunkSize });
    try {
      const table = await materializeToDataTable(sources[0], pool);
      const properties = table.columns.map((c) => ({
        name: c.name,
        type: c.dataType,
        byteSize: c.data.BYTES_PER_ELEMENT,
        storage: c.data,
      }));
      self.postMessage(
        { request: job.request, result: { count: table.numRows, properties } },
        { transfer: [...new Set(properties.map((p) => p.storage.buffer as ArrayBuffer))] },
      );
    } finally {
      pool.destroy();
      for (const source of sources) await source.close();
    }
  } catch (error) {
    self.postMessage({ request: job.request, error: String(error) });
  }
};
