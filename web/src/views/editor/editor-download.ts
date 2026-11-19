export type EditorWritable = {
  write(value: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export function downloadLength(response: Response): number | null {
  if (response.headers.get('Content-Encoding')) return null;
  const length = Number(response.headers.get('Content-Length'));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

export async function saveEditorResponse(response: Response, writable: EditorWritable, signal: AbortSignal,
  progress: (loaded: number) => void, closing: () => void = () => {}): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  try {
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    reader = response.body.getReader();
    signal.addEventListener('abort', cancel, { once: true });
    const total = downloadLength(response);
    let loaded = 0;
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      if (total !== null && loaded > total) throw new Error('下载长度与文件大小不一致');
      progress(loaded);
    }
    if (total !== null && loaded !== total) throw new Error('下载不完整，请重试');
    signal.throwIfAborted();
    closing();
    await writable.close();
  } catch (error) {
    await Promise.allSettled([reader?.cancel(), writable.abort()]);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader?.releaseLock();
  }
}
