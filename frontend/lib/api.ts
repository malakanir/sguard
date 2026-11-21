export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const TOKEN_KEY = 'sguard.accessToken';
const REFRESH_KEY = 'sguard.refreshToken';

/** localStorage bisa tidak tersedia (private window, site data diblokir), jadi semua akses dibungkus. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* tanpa storage, sesi hanya bertahan selama halaman terbuka */
  }
}

export const getToken = () => read(TOKEN_KEY);
export const getRefreshToken = () => read(REFRESH_KEY);

export function setSession(accessToken: string, refreshToken: string): void {
  write(TOKEN_KEY, accessToken);
  write(REFRESH_KEY, refreshToken);
}

export function clearToken(): void {
  write(TOKEN_KEY, null);
  write(REFRESH_KEY, null);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Format error backend: { statusCode, error, message: string | string[] }. */
async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(' · ') : body.message;
    return new ApiError(res.status, message ?? `Permintaan gagal (${res.status}).`);
  } catch {
    return new ApiError(res.status, `Permintaan gagal (${res.status}).`);
  }
}

function redirectToLogin(): void {
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.replace('/login');
  }
}

/** Satu refresh berjalan sekaligus, walaupun beberapa request gagal 401 bersamaan. */
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    setSession(body.accessToken, body.refreshToken);
    return true;
  } catch {
    return false;
  }
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    return await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Tidak bisa terhubung ke API. Pastikan backend berjalan.');
  }
}

/**
 * Request ke API. Saat access token kedaluwarsa (401), coba refresh sekali lalu ulangi request.
 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let res = await send(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    refreshing ??= refreshSession().finally(() => {
      refreshing = null;
    });
    const ok = await refreshing;
    if (ok) {
      res = await send(path, init);
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, 'Sesi berakhir. Silakan login lagi.');
    }
  }
  return res;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Unduh file dari endpoint yang butuh token (ekspor laporan). */
export async function download(path: string, filename: string): Promise<void> {
  const res = await request(path);
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
