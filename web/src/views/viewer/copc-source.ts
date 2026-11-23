// A local browser file or the range endpoint of a completed desktop conversion.
export type CopcSource = Blob | {url:string; key:string};

export async function readRange(file:CopcSource, begin:number, end:number, signal?:AbortSignal) {
  if (file instanceof Blob) return file.slice(begin,end).arrayBuffer();
  if (end===begin) return new ArrayBuffer(0);
  const headers=new Headers({Range:`bytes=${begin}-${end-1}`});
  if (file.key) headers.set('X-API-Key',file.key);
  const response=await fetch(file.url,{headers,signal});
  if (response.status!==206) throw Error('无法读取本地 COPC 分块：HTTP '+response.status);
  return response.arrayBuffer();
}
