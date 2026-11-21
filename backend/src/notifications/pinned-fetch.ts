import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface PinnedFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * Terhubung hanya ke alamat yang sudah divalidasi oleh assertSafeWebhookUrl.
 * Header Host dan SNI tetap memakai hostname asli; redirect tidak diikuti.
 */
export async function pinnedFetch(
  url: URL,
  addresses: string[],
  init: PinnedFetchInit,
): Promise<{ status: number }> {
  if (addresses.length === 0) throw new Error('Tidak ada alamat tujuan yang telah divalidasi.');
  const secure = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : secure ? 443 : 80;
  const path = `${url.pathname}${url.search}`;
  let lastError: unknown;
  for (const address of addresses) {
    let status: number;
    try {
      status = await new Promise<number>((resolve, reject) => {
        const req = (secure ? httpsRequest : httpRequest)(
          {
            hostname: address,
            port,
            path,
            method: init.method,
            headers: { ...init.headers, host: url.host },
            ...(secure ? { servername: url.hostname } : {}),
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.setTimeout(init.timeoutMs, () => req.destroy(new Error('Timeout saat mengirim webhook.')));
        req.on('error', reject);
        req.end(init.body);
      });
    } catch (err) {
      // Kegagalan koneksi: coba alamat tervalidasi berikutnya.
      lastError = err;
      continue;
    }
    // Respons diterima dari server: jangan kirim ulang ke alamat lain.
    if (status >= 300 && status < 400) throw new Error('Redirect webhook tidak diizinkan.');
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
    return { status };
  }
  throw lastError ?? new Error('Gagal menghubungi tujuan webhook.');
}
