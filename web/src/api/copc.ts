import {apiFetch} from './api-auth';

export interface CopcJob {id:string;name:string;status:'queued'|'converting'|'ready'|'failed';error:string}
export async function copcApi<T>(path:string, init?:RequestInit):Promise<T> {
  const response=await apiFetch('/api/copc/jobs'+path,init);
  if (!response.ok) {
    const body=await response.json().catch(()=>({}));
    throw Error(typeof body.detail==='string' ? body.detail : '本地转换服务不可用（HTTP '+response.status+'）');
  }
  return response.json();
}
export async function submitCopc(file:File,signal:AbortSignal) {
  const sample=await new Blob([file.slice(0,65536),file.slice(Math.max(0,file.size-65536))]).arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',sample);
  const fingerprint=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
  return copcApi<CopcJob>('',{method:'POST',headers:{'Content-Type':'application/json'},signal,
    body:JSON.stringify({name:file.name,size:file.size,fingerprint})});
}
