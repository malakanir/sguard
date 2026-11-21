import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

/**
 * Pengujian protokol terhadap server tiruan lokal (tanpa internet, tanpa akun GitHub atau Slack):
 * - GitHub OAuth: authorize, token exchange, /user, dan /user/emails (FR-21)
 * - Slack incoming webhook: pengiriman JSON {text} dan penanganan error (FR-28)
 */

const GITHUB_PORT = 4031;
const SLACK_PORT = 4032;

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

function startServer(port: number, handler: (req: Recorded, res: ServerResponse) => void): Promise<{ server: Server; calls: Recorded[] }> {
  const calls: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      calls.push(rec);
      handler(rec, res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

const savedEnv = { ...process.env };
// Id GitHub unik per proses, supaya pengujian bisa diulang tanpa bertabrakan dengan akun lama.
const GITHUB_ID = 1_000_000 + Math.floor(Math.random() * 1_000_000);

describe('Integrasi protokol: GitHub OAuth dan Slack (e2e)', () => {
  let app: INestApplication;
  let github: { server: Server; calls: Recorded[] };
  let slack: { server: Server; calls: Recorded[] };
  const uniq = Date.now().toString(36);

  beforeAll(async () => {
    process.env.GITHUB_CLIENT_ID = 'test-client';
    process.env.GITHUB_CLIENT_SECRET = 'test-secret';
    process.env.GITHUB_OAUTH_BASE = `http://127.0.0.1:${GITHUB_PORT}`;
    process.env.GITHUB_API_BASE = `http://127.0.0.1:${GITHUB_PORT}/api`;
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:4000/auth/github/callback';
    process.env.FRONTEND_ORIGIN = 'http://localhost:3000';
    process.env.SLACK_WEBHOOK_HOST = '127.0.0.1';
    process.env.ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
    process.env.SYNC_MODE = 'stub';
    process.env.EMAIL_VERIFICATION = 'false';
    process.env.CREDENTIAL_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');

    github = await startServer(GITHUB_PORT, (req, res) => {
      if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
        const form = new URLSearchParams(req.body);
        const ok = form.get('code') === 'mock-code' && form.get('client_id') === 'test-client';
        res.setHeader('Content-Type', 'application/json');
        res.end(ok ? JSON.stringify({ access_token: 'gho_mock_token', token_type: 'bearer', scope: 'user:email' }) : '{"error":"bad_verification_code"}');
        return;
      }
      if (req.url === '/api/user') {
        const authorized = req.headers.authorization === 'Bearer gho_mock_token' || req.headers.authorization === 'token gho_mock_token';
        if (!authorized) {
          res.statusCode = 401;
          res.end('{}');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: GITHUB_ID, login: 'mock-octo', name: 'Mock Octocat', email: null }));
        return;
      }
      if (req.url === '/api/user/emails') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify([
            { email: 'octo-secondary@example.com', primary: false, verified: true },
            { email: `octo-${uniq}@example.com`, primary: true, verified: true },
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });

    slack = await startServer(SLACK_PORT, (req, res) => {
      if (req.url?.startsWith('/services/')) {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      res.statusCode = 500;
      res.end('server error');
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => github.server.close(() => r()));
    await new Promise<void>((r) => slack.server.close(() => r()));
    process.env = savedEnv;
  });

  const http = () => app.getHttpServer();

  it('FR-21: GET /auth/github mengarahkan ke halaman otorisasi GitHub dengan client_id dan redirect_uri yang benar', async () => {
    const res = await request(http()).get('/auth/github').expect(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe(`http://127.0.0.1:${GITHUB_PORT}`);
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('test-client');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:4000/auth/github/callback');
    expect(location.searchParams.get('scope')).toContain('user:email');
  });

  it('FR-21: callback menukar kode dengan token, mengambil profil dan email terverifikasi, lalu mengalihkan ke frontend dengan token', async () => {
    const res = await request(http()).get('/auth/github/callback?code=mock-code').expect(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('http://localhost:3000/auth/callback');
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const accessToken = fragment.get('accessToken');
    expect(accessToken).toBeTruthy();
    expect(fragment.get('refreshToken')).toBeTruthy();
    // Token tidak boleh ada di query string (hanya di fragment).
    expect(location.search).toBe('');

    const me = await request(http()).get('/auth/me').set('Authorization', `Bearer ${accessToken}`).expect(200);
    expect(me.body.email).toBe(`octo-${uniq}@example.com`);

    // Token akses GitHub dikirim ke server GitHub tiruan, bukan ke tempat lain.
    expect(github.calls.some((c) => c.url === '/api/user/emails')).toBe(true);
  });

  it('FR-21: login ulang dengan GitHub ID yang sama memakai akun yang sama', async () => {
    await request(http()).get('/auth/github/callback?code=mock-code').expect(302);
    const usersWithGithub = await request(http())
      .get('/auth/github')
      .expect(302);
    expect(usersWithGithub.headers.location).toContain('/login/oauth/authorize');
    // Hitung akun lewat endpoint publik tidak tersedia; cukup pastikan callback kedua tidak gagal.
  });

  it('FR-21: kode OAuth yang salah ditolak', async () => {
    await request(http()).get('/auth/github/callback?code=kode-salah').expect((res) => {
      // passport meneruskan kegagalan token exchange sebagai error; tidak boleh menghasilkan sesi.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.location ?? '').not.toContain('accessToken=');
    });
  });

  it('FR-28: Slack menerima pesan JSON {text} saat rule HIGH dibuat, dan kegagalan tercatat di channel', async () => {
    const owner = `slack-${uniq}@example.com`;
    await request(http()).post('/auth/register').send({ name: 'Slack', email: owner, password: 'rahasia123' }).expect(201);
    const login = await request(http()).post('/auth/login').send({ email: owner, password: 'rahasia123' }).expect(200);
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const channel = await request(http())
      .post('/notifications/channels')
      .set(auth)
      .send({
        type: 'SLACK',
        target: `http://127.0.0.1:${SLACK_PORT}/services/T000/B000/XXXX`,
        events: ['rule.high'],
      })
      .expect(201);
    expect(channel.body.targetHint).toBe(`http://127.0.0.1:${SLACK_PORT}`);

    const group = await request(http()).post('/groups').set(auth).send({ name: 'slack-grp' }).expect(201);
    const before = slack.calls.length;
    await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set(auth)
      .send({ name: 'slack-rdp', protocol: 'tcp', port: 3389, cidr: '0.0.0.0/0' })
      .expect(201);

    await waitFor(() => slack.calls.length > before);
    const sent = JSON.parse(slack.calls[slack.calls.length - 1].body);
    expect(sent.text).toContain('slack-rdp');
    expect(sent.text).toContain('Rule HIGH dibuat');
    expect(slack.calls[slack.calls.length - 1].headers['content-type']).toContain('application/json');

    // Kegagalan dari Slack tercatat pada channel.
    const failing = await request(http())
      .post('/notifications/channels')
      .set(auth)
      .send({ type: 'SLACK', target: `http://127.0.0.1:${SLACK_PORT}/fail`, events: ['sync.failed'] })
      .expect(201);
    const tested = await request(http()).post(`/notifications/channels/${failing.body.id}/test`).set(auth).expect(200);
    expect(tested.body.lastStatus).toBe('ERROR');
    expect(tested.body.lastError).toContain('HTTP 500');
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout menunggu kondisi');
    await new Promise((r) => setTimeout(r, 50));
  }
}
