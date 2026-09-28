import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createChunkDataPool, decimateSource, getInputFormat, readFile, writeSource } from '@playcanvas/splat-transform';

const [input, targetText, output] = process.argv.slice(2);
const targetCount = Number(targetText);
if (!input || !output || !Number.isSafeInteger(targetCount) || targetCount < 1) {
  throw new Error('Usage: decimate_cpu.mjs <input.ply> <positive target count> <output.ply>');
}

const readFs = {
  async createSource(filename) {
    const handle = await open(filename, 'r');
    const size = (await handle.stat()).size;
    return {
      size, seekable: true,
      read(start = 0, end = size) {
        let position = Math.max(0, Math.min(start, size));
        const limit = Math.max(position, Math.min(end, size));
        return {
          expectedSize: limit - position, bytesRead: 0,
          async pull(buffer) {
            const length = Math.min(buffer.length, limit - position);
            if (length <= 0) return 0;
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            position += bytesRead;
            this.bytesRead += bytesRead;
            return bytesRead;
          },
          close() {},
        };
      },
      close() { void handle.close(); },
    };
  },
};

const writeFs = {
  async mkdir(path) { await mkdir(path, { recursive: true }); },
  async createWriter(filename) {
    await mkdir(dirname(filename), { recursive: true });
    const temp = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, 'wx');
    return {
      bytesWritten: 0,
      async write(data) {
        let offset = 0;
        while (offset < data.length) {
          const { bytesWritten } = await handle.write(data, offset, data.length - offset);
          if (bytesWritten === 0) throw new Error('Failed to write decimated PLY');
          offset += bytesWritten;
          this.bytesWritten += bytesWritten;
        }
      },
      async close() { await handle.sync(); await handle.close(); await rename(temp, filename); },
      async abort() { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); },
    };
  },
};

const pool = createChunkDataPool();
const [source] = await readFile({ filename: input, inputFormat: getInputFormat(input), fileSystem: readFs });
let result;
try {
  result = await decimateSource(source, pool, {
    targetCount,
    spill: { readFs, writeFs, scratchDir: dirname(output), remove: unlink },
  });
  await writeSource({ filename: output, outputFormat: 'ply', source: result, pool, options: {} }, writeFs);
} finally {
  await (result ?? source).close();
}
