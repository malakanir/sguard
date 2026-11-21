import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { MAIL_SENDER, MailSender, OutgoingMail } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { assertSafeWebhookUrl } from '../src/notifications/url-guard';
import { CLOUD_CLIENT, StubCloudClient } from '../src/sync/cloud-client';
import { ScanService } from '../src/scan/scan.service';

const WEBHOOK_PORT = 4012;
const SECRET = 'topsecret-webhook';

class CapturingMail implements MailSender {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
  }
}

const savedEnv = { ...process.env };

describe('Fase 2 dan 3 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cloud: StubCloudClient;
  let webhookServer: Server;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];
  const mail = new CapturingMail();
  const uniq = Date.now().toString(36);

  beforeAll(async () => {
    process.env.EMAIL_VERIFICATION = 'false';
    process.env.SYNC_MODE = 'stub';
    process.env.SYNC_TRANSPORT = 'local';
    process.env.ALLOW_INSECURE_WEBHOOKS = 'true';
    process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');

    webhookServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => webhookServer.listen(WEBHOOK_PORT, '127.0.0.1', () => resolve()));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    cloud = app.get(CLOUD_CLIENT) as StubCloudClient;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    process.env = savedEnv;
  });

  const http = () => app.getHttpServer();

  async function login(label: string) {
    const email = `${label}-${uniq}@example.com`;
    await request(http()).post('/auth/register').send({ name: label, email, password: 'rahasia123' }).expect(201);
    const res = await request(http()).post('/auth/login').send({ email, password: 'rahasia123' }).expect(200);
    return { id: res.body.user.id as string, email, token: res.body.accessToken as string };
  }

  async function group(token: string, name: string, extra: Record<string, unknown> = {}) {
    const res = await request(http())
      .post('/groups')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, ...extra })
      .expect(201);
    return res.body as { id: string; flociGroupId: string; syncStatus: string };
  }

  /* ---------- FR-25: rate limit login ---------- */

  it('FR-25: login dibatasi setelah 5 kegagalan, dan login benar pun ditolak sampai jendela habis', async () => {
    const u = await login('ratelimit');
    for (let i = 0; i < 5; i++) {
      await request(http()).post('/auth/login').send({ email: u.email, password: 'salah-sekali' }).expect(401);
    }
    await request(http()).post('/auth/login').send({ email: u.email, password: 'rahasia123' }).expect(429);
  });

  /* ---------- FR-24: rule egress, rentang port, IPv6, CIDR lebar ---------- */

  it('FR-24: validasi CIDR dan rentang port', async () => {
    const u = await login('validate');
    const auth = { Authorization: `Bearer ${u.token}` };
    const g = await group(u.token, 'validate-grp');
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'bad-cidr', protocol: 'tcp', port: 22, cidr: '10.0.0.0/33' })
      .expect(400);
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'bad-range', protocol: 'tcp', port: 443, portTo: 80, cidr: '10.0.0.0/24' })
      .expect(400);
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'icmp-port', protocol: 'icmp', port: 22, cidr: '10.0.0.0/24' })
      .expect(400);
  });

  it('FR-24: rentang port yang mencakup port sensitif terbuka ke internet dinilai HIGH; CIDR /8 dinilai MEDIUM', async () => {
    const u = await login('risk-range');
    const auth = { Authorization: `Bearer ${u.token}` };
    const g = await group(u.token, 'range-grp');

    const range = await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'wide-range', protocol: 'tcp', port: 20, portTo: 30000, cidr: '0.0.0.0/0' })
      .expect(201);
    expect(range.body.riskLevel).toBe('HIGH');
    expect(range.body.riskReason).toContain('mencakup port 22');
    expect(range.body.portTo).toBe(30000);

    const wide = await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'corp-ssh', protocol: 'tcp', port: 22, cidr: '10.0.0.0/8' })
      .expect(201);
    expect(wide.body.riskLevel).toBe('MEDIUM');
    expect(wide.body.riskReason).toContain('terlalu lebar');
  });

  it('FR-24: IPv6 dinilai dan disimulasikan; rule egress dibedakan dari ingress', async () => {
    const u = await login('ipv6');
    const auth = { Authorization: `Bearer ${u.token}` };
    const g = await group(u.token, 'v6-grp');

    const openSsh = await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'v6-ssh', protocol: 'tcp', port: 22, cidr: '::/0' })
      .expect(201);
    expect(openSsh.body.riskLevel).toBe('HIGH');

    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'v6-https', protocol: 'tcp', port: 443, cidr: '2001:db8::/32' })
      .expect(201);

    const allowed = await request(http())
      .post(`/groups/${g.id}/simulate`)
      .set(auth)
      .send({ sourceIp: '2001:db8::5', protocol: 'tcp', port: 443 })
      .expect(200);
    expect(allowed.body.decision).toBe('ALLOW');

    const denied = await request(http())
      .post(`/groups/${g.id}/simulate`)
      .set(auth)
      .send({ sourceIp: '2001:4860::1', protocol: 'tcp', port: 443 })
      .expect(200);
    expect(denied.body.decision).toBe('DENY');

    // Egress tidak cocok dengan simulasi ingress.
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'out-db', direction: 'EGRESS', protocol: 'tcp', port: 5432, cidr: '10.0.0.0/8' })
      .expect(201);
    const egress = await request(http())
      .post(`/groups/${g.id}/simulate`)
      .set(auth)
      .send({ sourceIp: '10.1.2.3', protocol: 'tcp', port: 5432, direction: 'EGRESS' })
      .expect(200);
    expect(egress.body.decision).toBe('ALLOW');
    const ingress = await request(http())
      .post(`/groups/${g.id}/simulate`)
      .set(auth)
      .send({ sourceIp: '10.1.2.3', protocol: 'tcp', port: 5432 })
      .expect(200);
    expect(ingress.body.decision).toBe('DENY');
  });

  it('FR-24: rentang port dan IPv6 ikut dikirim ke cloud dan dibaca kembali saat drift', async () => {
    const u = await login('cloud-v6');
    const auth = { Authorization: `Bearer ${u.token}` };
    const g = await group(u.token, 'cloud-v6-grp');
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'v6-range', protocol: 'tcp', port: 8000, portTo: 8100, cidr: '2001:db8::/48' })
      .expect(201);
    const drift = await request(http()).get(`/groups/${g.id}/drift`).set(auth).expect(200);
    expect(drift.body.status).toBe('IN_SYNC');
    const described = await cloud.describe(g.flociGroupId);
    expect(described.rules).toContainEqual(
      expect.objectContaining({ direction: 'INGRESS', protocol: 'tcp', port: 8000, portTo: 8100, cidr: '2001:db8::/48' }),
    );
  });

  /* ---------- FR-25: scan drift terjadwal ---------- */

  it('FR-25: scan menandai DRIFT saat isi cloud berbeda, dan OK setelah diperbaiki', async () => {
    const u = await login('scan');
    const auth = { Authorization: `Bearer ${u.token}` };
    const g = await group(u.token, 'scan-grp');
    const rule = await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'scan-https', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' })
      .expect(201);
    expect(rule.body.syncStatus).toBe('SYNCED');

    const ok = await request(http()).post(`/groups/${g.id}/scan`).set(auth).expect(200);
    expect(ok.body.status).toBe('OK');

    await cloud.revoke(g.flociGroupId, { protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' });
    const drifted = await request(http()).post(`/groups/${g.id}/scan`).set(auth).expect(200);
    expect(drifted.body.status).toBe('DRIFT');
    const detail = await request(http()).get(`/groups/${g.id}`).set(auth).expect(200);
    expect(detail.body.lastScanStatus).toBe('DRIFT');
    expect(detail.body.lastScanAt).toBeTruthy();

    await request(http()).post(`/groups/${g.id}/drift/repair`).set(auth).expect(200);
    const recovered = await request(http()).post(`/groups/${g.id}/scan`).set(auth).expect(200);
    expect(recovered.body.status).toBe('OK');

    // Scan terjadwal memeriksa semua group; hasilnya tersimpan.
    const scanner = app.get(ScanService);
    const run = await scanner.runScheduled();
    expect(run.scanned).toBeGreaterThan(0);
  });

  /* ---------- FR-27: berbagi group ---------- */

  it('FR-27: pemilik membagikan group; VIEWER hanya membaca, EDITOR boleh mengubah, non-member tidak melihat', async () => {
    const owner = await login('share-owner');
    const viewer = await login('share-viewer');
    const editor = await login('share-editor');
    const outsider = await login('share-outsider');
    const g = await group(owner.token, 'shared-grp');

    await request(http())
      .post(`/groups/${g.id}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: viewer.email, role: 'VIEWER' })
      .expect(201);
    await request(http())
      .post(`/groups/${g.id}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: editor.email, role: 'EDITOR' })
      .expect(201);

    // VIEWER melihat group dan rule, tetapi tidak bisa membuat rule.
    const seen = await request(http()).get(`/groups/${g.id}`).set('Authorization', `Bearer ${viewer.token}`).expect(200);
    expect(seen.body.myRole).toBe('VIEWER');
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ name: 'nope', protocol: 'tcp', port: 80, cidr: '10.0.0.0/8' })
      .expect(403);
    const list = await request(http()).get('/groups').set('Authorization', `Bearer ${viewer.token}`).expect(200);
    expect(list.body.data.find((x: { id: string }) => x.id === g.id)?.myRole).toBe('VIEWER');

    // EDITOR boleh membuat rule.
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ name: 'by-editor', protocol: 'tcp', port: 8080, cidr: '10.0.0.0/8' })
      .expect(201);

    // Non-member tidak melihat group sama sekali.
    await request(http()).get(`/groups/${g.id}`).set('Authorization', `Bearer ${outsider.token}`).expect(404);

    // Hanya pemilik yang bisa membagikan atau menghapus group.
    await request(http())
      .post(`/groups/${g.id}/members`)
      .set('Authorization', `Bearer ${editor.token}`)
      .send({ email: outsider.email, role: 'VIEWER' })
      .expect(403);
    await request(http()).delete(`/groups/${g.id}`).set('Authorization', `Bearer ${editor.token}`).expect(403);

    // Member keluar sendiri; setelah itu tidak punya akses.
    await request(http()).delete(`/groups/${g.id}/members/${viewer.id}`).set('Authorization', `Bearer ${viewer.token}`).expect(204);
    await request(http()).get(`/groups/${g.id}`).set('Authorization', `Bearer ${viewer.token}`).expect(404);

    const members = await request(http()).get(`/groups/${g.id}/members`).set('Authorization', `Bearer ${owner.token}`).expect(200);
    expect(members.body.map((m: { role: string }) => m.role).sort()).toEqual(['EDITOR', 'OWNER']);
  });

  /* ---------- FR-28: notifikasi ---------- */

  it('FR-28: webhook menerima rule.high dengan tanda tangan Standard Webhooks; channel tampil tanpa secret', async () => {
    const u = await login('notify');
    const auth = { Authorization: `Bearer ${u.token}` };
    const channel = await request(http())
      .post('/notifications/channels')
      .set(auth)
      .send({
        type: 'WEBHOOK',
        target: `http://127.0.0.1:${WEBHOOK_PORT}/hook`,
        events: ['rule.high'],
        secret: SECRET,
      })
      .expect(201);
    expect(channel.body.targetHint).toBe(`http://127.0.0.1:${WEBHOOK_PORT}`);
    expect(channel.body).not.toHaveProperty('secret');
    expect(JSON.stringify(channel.body)).not.toContain('/hook');

    const g = await group(u.token, 'notify-grp');
    const before = received.length;
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set(auth)
      .send({ name: 'notify-ssh', protocol: 'tcp', port: 22, cidr: '0.0.0.0/0' })
      .expect(201);

    await waitFor(() => received.length > before);
    const delivered = received[received.length - 1];
    const payload = JSON.parse(delivered.body);
    expect(payload.type).toBe('rule.high');
    expect(payload.data.name).toBe('notify-ssh');

    const id = delivered.headers['webhook-id'] as string;
    const ts = delivered.headers['webhook-timestamp'] as string;
    const expected = `v1,${createHmac('sha256', SECRET).update(`${id}.${ts}.${delivered.body}`).digest('base64')}`;
    expect(delivered.headers['webhook-signature']).toBe(expected);

    const test = await request(http()).post(`/notifications/channels/${channel.body.id}/test`).set(auth).expect(200);
    expect(test.body.lastStatus).toBe('OK');
  });

  it('FR-28: email menerima rule.high; channel milik orang lain tidak bisa diakses', async () => {
    const owner = await login('notify-mail');
    const other = await login('notify-other');
    const channel = await request(http())
      .post('/notifications/channels')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ type: 'EMAIL', target: owner.email, events: ['rule.high'] })
      .expect(201);
    expect(channel.body.targetHint).toContain('@example.com');

    await request(http())
      .delete(`/notifications/channels/${channel.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);

    const g = await group(owner.token, 'mail-grp');
    const before = mail.sent.length;
    await request(http())
      .post(`/groups/${g.id}/rules`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'mail-rdp', protocol: 'tcp', port: 3389, cidr: '0.0.0.0/0' })
      .expect(201);
    await waitFor(() => mail.sent.length > before);
    expect(mail.sent[mail.sent.length - 1].to).toBe(owner.email);
  });

  it('FR-28: target Slack harus host hooks.slack.com; URL privat ditolak tanpa pengecualian', async () => {
    const u = await login('notify-slack');
    const auth = { Authorization: `Bearer ${u.token}` };
    await request(http())
      .post('/notifications/channels')
      .set(auth)
      .send({ type: 'SLACK', target: 'https://example.com/hook', events: ['sync.failed'] })
      .expect(400);
    const slack = await request(http())
      .post('/notifications/channels')
      .set(auth)
      .send({ type: 'SLACK', target: 'https://hooks.slack.com/services/T000/B000/XXXX', events: ['sync.failed'] })
      .expect(201);
    expect(slack.body.targetHint).toBe('https://hooks.slack.com');

    await expect(
      assertSafeWebhookUrl('http://127.0.0.1/x', { allowInsecure: false, allowPrivate: false }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      assertSafeWebhookUrl('https://10.1.2.3/x', { allowInsecure: false, allowPrivate: false }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      assertSafeWebhookUrl('http://example.com/x', { allowInsecure: false, allowPrivate: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  /* ---------- FR-26: akun AWS dan kredensial terenkripsi ---------- */

  it('FR-26: kredensial AWS terenkripsi, tidak pernah dikembalikan, dan akun yang dipakai tidak bisa dihapus', async () => {
    const u = await login('aws');
    const auth = { Authorization: `Bearer ${u.token}` };
    const secret = 'AKIAEXAMPLESECRETKEY-1234567890';
    const created = await request(http())
      .post('/aws-accounts')
      .set(auth)
      .send({
        name: 'prod-ap',
        region: 'ap-southeast-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: secret,
      })
      .expect(201);
    expect(created.body.accessKeyIdHint).toBe('****MPLE');
    expect(JSON.stringify(created.body)).not.toContain(secret);

    const row = await prisma.awsAccount.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.secretAccessKeyEnc).not.toContain(secret);
    expect(row.secretAccessKeyEnc.startsWith('v1:')).toBe(true);

    await request(http())
      .post('/aws-accounts')
      .set(auth)
      .send({ name: 'bad', region: 'mars-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: secret })
      .expect(400);

    const verified = await request(http()).post(`/aws-accounts/${created.body.id}/test`).set(auth).expect(200);
    expect(verified.body.lastVerifiedAt).toBeTruthy();

    const g = await group(u.token, 'aws-grp', { awsAccountId: created.body.id });
    expect(g.syncStatus).toBe('SYNCED');

    await request(http()).delete(`/aws-accounts/${created.body.id}`).set(auth).expect(409);
    await request(http()).delete(`/groups/${g.id}`).set(auth).expect(204);
    await request(http()).delete(`/aws-accounts/${created.body.id}`).set(auth).expect(204);
  });

  it('FR-26: akun AWS milik orang lain tidak bisa dipakai untuk group', async () => {
    const owner = await login('aws-owner');
    const thief = await login('aws-thief');
    const acc = await request(http())
      .post('/aws-accounts')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'mine', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret-secret-1234' })
      .expect(201);
    await request(http())
      .post('/groups')
      .set('Authorization', `Bearer ${thief.token}`)
      .send({ name: 'stolen', awsAccountId: acc.body.id })
      .expect(404);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout menunggu kondisi');
    await new Promise((r) => setTimeout(r, 50));
  }
}
