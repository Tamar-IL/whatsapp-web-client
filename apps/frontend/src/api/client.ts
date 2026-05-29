/**
 * Tiny fetch wrapper. Knows about:
 *  - same-origin credentials (session cookie)
 *  - CSRF double-submit token (cookie → header)
 *  - JSON request/response convention
 *  - typed error shape { code, message, details? }
 */

const CSRF_COOKIE_NAME = 'wweb_csrf';

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]!) : null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  // CSRF for mutating methods
  if (method !== 'GET') {
    const csrf = getCookie(CSRF_COOKIE_NAME);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const ct = res.headers.get('content-type') ?? '';
  const data: unknown = ct.includes('application/json') ? await res.json() : await res.text();

  if (!res.ok) {
    const err = (data as { code?: string; message?: string; details?: unknown }) ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? res.statusText, err.details);
  }

  return data as T;
}

// Convenience GET that primes the CSRF cookie (if missing). Useful as the first
// call from any page so subsequent mutations have a token to echo.
export async function ensureCsrf(): Promise<void> {
  await fetch('/api/auth/me', { credentials: 'include' }).catch(() => undefined);
}

/**
 * Multipart upload (file send). Browser sets the multipart Content-Type with its
 * boundary, so we must NOT set it manually — only the CSRF header.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const csrf = getCookie(CSRF_COOKIE_NAME);
  if (csrf) headers['X-CSRF-Token'] = csrf;

  const res = await fetch(path, { method: 'POST', headers, credentials: 'include', body: form });
  const ct = res.headers.get('content-type') ?? '';
  const data: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as { code?: string; message?: string }) ?? {};
    throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? res.statusText);
  }
  return data as T;
}
