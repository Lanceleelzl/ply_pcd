const API_KEY_STORAGE = 'ply-pcd-registration-api-key';

export function getApiKey(): string {
  if (typeof sessionStorage === 'undefined') return '';
  return sessionStorage.getItem(API_KEY_STORAGE) ?? '';
}

export function setApiKey(value: string): void {
  if (typeof sessionStorage === 'undefined') return;
  const key = value.trim();
  if (key) sessionStorage.setItem(API_KEY_STORAGE, key);
  else sessionStorage.removeItem(API_KEY_STORAGE);
}

export function authenticatedHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  const key = getApiKey();
  if (key) headers.set('X-API-Key', key);
  return headers;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: authenticatedHeaders(init.headers) });
}

export function authenticateRequest(request: XMLHttpRequest): void {
  const key = getApiKey();
  if (key) request.setRequestHeader('X-API-Key', key);
}
