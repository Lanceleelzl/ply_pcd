import { ReadStream, type ReadSource } from '@playcanvas/splat-transform';

export function blobSource(blob: Blob): ReadSource {
  return {
    size: blob.size,
    seekable: true,
    close() {},
    read(start = 0, end = blob.size) {
      let offset = start;
      return new (class extends ReadStream {
        async pull(target: Uint8Array) {
          const bytes = new Uint8Array(
            await blob.slice(offset, Math.min(end, offset + target.length)).arrayBuffer(),
          );
          target.set(bytes);
          offset += bytes.length;
          this.bytesRead += bytes.length;
          return bytes.length;
        }
      })(end - start);
    },
  };
}
