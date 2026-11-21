import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedFetch } from './pinned-fetch.js';

const servers: ReturnType<typeof createServer>[] = [];

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function listen(handler: Handler): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

describe('pinnedFetch', () => {
  it('connects to the validated address and preserves the original Host header', async () => {
    let seenHost = '';
    const port = await listen((req, res) => {
      seenHost = req.headers.host ?? '';
      res.writeHead(200).end('ok');
    });
    // Hostname tidak bisa di-resolve; koneksi harus tetap ke alamat yang sudah divalidasi.
    const url = new URL(`http://rebind-target.test:${port}/hook`);
    const result = await pinnedFetch(url, ['127.0.0.1'], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: 2000,
    });
    expect(result.status).toBe(200);
    expect(seenHost).toBe(`rebind-target.test:${port}`);
  });

  it('rejects redirect responses', async () => {
    const port = await listen((_req, res) => res.writeHead(302, { location: 'http://127.0.0.1/' }).end());
    const url = new URL(`http://example.test:${port}/hook`);
    await expect(
      pinnedFetch(url, ['127.0.0.1'], { method: 'POST', headers: {}, body: '', timeoutMs: 2000 }),
    ).rejects.toThrow(/redirect/i);
  });

  it('does not retry a delivered non-2xx response on another address', async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits += 1;
      res.writeHead(500).end();
    });
    const url = new URL(`http://example.test:${port}/hook`);
    await expect(
      pinnedFetch(url, ['127.0.0.1', '127.0.0.2'], { method: 'POST', headers: {}, body: '', timeoutMs: 2000 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(hits).toBe(1);
  });
});
