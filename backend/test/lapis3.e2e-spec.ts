import { INestApplication, INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { MAIL_SENDER, MailSender, OutgoingMail } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CLOUD_CLIENT, StubCloudClient } from '../src/sync/cloud-client';
import { WorkerModule } from '../src/worker/worker.module';

const WORKER_PORT = 4011;

/** Menangkap email yang dikirim, supaya test bisa membaca tautan verifikasi. */
class CapturingMail implements MailSender {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
  }
}

function nextEvent<T>(socket: Socket, name: string, match: (payload: T) => boolean, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout menunggu event ${name}`)), timeoutMs);
    const handler = (payload: T) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(payload);
    };
    socket.on(name, handler);
  });
}

const savedEnv = { ...process.env };

describe('Lapis 3 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  const cloud = new StubCloudClient();
  const mail = new CapturingMail();
  const uniq = Date.now().toString(36);

  beforeAll(async () => {
    process.env.EMAIL_VERIFICATION = 'true';
    process.env.SYNC_TRANSPORT = 'tcp';
    process.env.SYNC_WORKER_HOST = '127.0.0.1';
    process.env.SYNC_WORKER_PORT = String(WORKER_PORT);
    delete process.env.GITHUB_CLIENT_ID;

    // sync-worker berjalan di proses yang sama, memakai cloud stub yang sama dengan test.
    const workerRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(CLOUD_CLIENT)
      .useValue(cloud)
      .compile();
    worker = workerRef.createNestMicroservice<MicroserviceOptions>({
      transport: Transport.TCP,
      options: { host: '127.0.0.1', port: WORKER_PORT },
    });
    await worker.listen();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    prisma = app.get(PrismaService);
  });

  let worker: INestMicroservice;

  afterAll(async () => {
    await app.close();
    await worker.close();
    process.env = savedEnv;
  });

  const http = () => app.getHttpServer();

  async function verifiedToken(label: string) {
    const email = `${label}-${uniq}@example.com`;
    await request(http()).post('/auth/register').send({ name: label, email, password: 'rahasia123' }).expect(201);
    const last = mail.sent[mail.sent.length - 1];
    const token = new URL(last.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    await request(http()).get(`/auth/verify-email?token=${token}`).expect(200);
    const login = await request(http()).post('/auth/login').send({ email, password: 'rahasia123' }).expect(200);
    return { id: login.body.user.id as string, token: login.body.accessToken as string };
  }

  it('FR-22: register mengirim tautan, login ditolak sebelum verifikasi, tautan hanya sekali pakai', async () => {
    const config = await request(http()).get('/auth/config').expect(200);
    expect(config.body).toEqual({ emailVerification: true, github: false });

    const email = `verify-${uniq}@example.com`;
    const reg = await request(http()).post('/auth/register').send({ name: 'V', email, password: 'rahasia123' }).expect(201);
    expect(reg.body.emailVerificationRequired).toBe(true);

    await request(http()).post('/auth/login').send({ email, password: 'rahasia123' }).expect(403);

    const sent = mail.sent[mail.sent.length - 1];
    expect(sent.to).toBe(email);
    const token = new URL(sent.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    await request(http()).get(`/auth/verify-email?token=${token}`).expect(200);
    await request(http()).get(`/auth/verify-email?token=${token}`).expect(400);
    await request(http()).get('/auth/verify-email?token=salah').expect(400);
    await request(http()).post('/auth/login').send({ email, password: 'rahasia123' }).expect(200);
  });

  it('FR-20: rule.high dan sync.changed dikirim realtime hanya ke pemilik data', async () => {
    const owner = await verifiedToken('ws-owner');
    const other = await verifiedToken('ws-other');

    const socket = io(`${baseUrl}/events`, { auth: { token: owner.token }, transports: ['websocket'] });
    const otherSocket = io(`${baseUrl}/events`, { auth: { token: other.token }, transports: ['websocket'] });
    await Promise.all([
      new Promise((r) => socket.on('ready', r)),
      new Promise((r) => otherSocket.on('ready', r)),
    ]);

    const highPromise = nextEvent<{ ruleId: string; name: string; riskReason: string }>(
      socket,
      'rule.high',
      (p) => p.name === 'WS SSH',
    );
    const changedPromise = nextEvent<{ kind: string; status: string; name: string }>(
      socket,
      'sync.changed',
      (p) => p.kind === 'group' && p.name === 'ws-group',
    );
    let leaked = false;
    otherSocket.on('rule.high', () => (leaked = true));
    otherSocket.on('sync.changed', () => (leaked = true));

    const group = await request(http())
      .post('/groups')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'ws-group' })
      .expect(201);
    await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'WS SSH', protocol: 'tcp', port: 22, cidr: '0.0.0.0/0' })
      .expect(201);

    const high = await highPromise;
    expect(high.riskReason).toContain('Port 22');
    const changed = await changedPromise;
    expect(changed.status).toBe('SYNCED');

    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);

    socket.close();
    otherSocket.close();
  });

  it('FR-20: koneksi tanpa token valid ditolak', async () => {
    const bad = io(`${baseUrl}/events`, { auth: { token: 'tidak-valid' }, transports: ['websocket'] });
    await new Promise<void>((resolve) => bad.on('disconnect', () => resolve()));
    expect(bad.connected).toBe(false);
    bad.close();
  });

  it('FR-23: sync dijalankan lewat sync-worker (TCP), hasilnya tetap tersimpan dan terlihat di cloud', async () => {
    const u = await verifiedToken('worker');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: 'worker-grp' }).expect(201);
    expect(group.body.syncStatus).toBe('SYNCED');
    const flociId = group.body.flociGroupId as string;
    expect(flociId).toMatch(/^sg-stub-/);

    const rule = await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set(auth)
      .send({ name: 'worker-https', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' })
      .expect(201);
    expect(rule.body.syncStatus).toBe('SYNCED');
    const described = await cloud.describe(flociId);
    expect(described.rules).toContainEqual(expect.objectContaining({ protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' }));

    // Drift lewat worker: hapus dari cloud secara langsung, lalu perbaiki.
    await cloud.revoke(flociId, { protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' });
    const drift = await request(http()).get(`/groups/${group.body.id}/drift`).set(auth).expect(200);
    expect(drift.body.status).toBe('DRIFT');
    const repaired = await request(http()).post(`/groups/${group.body.id}/drift/repair`).set(auth).expect(200);
    expect(repaired.body.status).toBe('IN_SYNC');
  });

  it('FR-18: group yang hilang di cloud terdeteksi dan dibuat ulang lewat repair', async () => {
    const u = await verifiedToken('gone');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: 'gone-grp' }).expect(201);
    const gid = group.body.id as string;
    await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: 'gone-ssh', protocol: 'tcp', port: 2222, cidr: '10.0.0.5/32' })
      .expect(201);

    // Group dihapus langsung di cloud, di luar SGuard.
    await cloud.deleteGroup(group.body.flociGroupId as string);

    const drift = await request(http()).get(`/groups/${gid}/drift`).set(auth).expect(200);
    expect(drift.body.status).toBe('DRIFT');
    expect(drift.body.groupMissingInCloud).toBe(true);
    expect(drift.body.missingInCloud).toHaveLength(1);

    const repaired = await request(http()).post(`/groups/${gid}/drift/repair`).set(auth).expect(200);
    expect(repaired.body.status).toBe('IN_SYNC');
    expect(repaired.body.groupMissingInCloud).toBe(false);
    const newFloci = (await request(http()).get(`/groups/${gid}`).set(auth).expect(200)).body.flociGroupId as string;
    expect(newFloci).toMatch(/^sg-stub-/);
    expect(newFloci).not.toBe(group.body.flociGroupId);
    expect((await cloud.describe(newFloci)).rules).toContainEqual(expect.objectContaining({ protocol: 'tcp', port: 2222, cidr: '10.0.0.5/32' }));
  });

  it('FR-21: login GitHub nonaktif tanpa konfigurasi; akun dibuat atau dihubungkan dengan benar', async () => {
    await request(http()).get('/auth/github').expect(404);

    const auth = app.get(AuthService);
    const created = await auth.loginWithGithub({
      githubId: `gh-${uniq}`,
      email: `gh-${uniq}@example.com`,
      name: 'GH User',
    });
    expect(created.accessToken).toBeTruthy();
    const me = await request(http()).get('/auth/me').set('Authorization', `Bearer ${created.accessToken}`).expect(200);
    expect(me.body.email).toBe(`gh-${uniq}@example.com`);

    // Login ulang dengan githubId yang sama tidak membuat akun baru.
    await auth.loginWithGithub({ githubId: `gh-${uniq}`, email: null, name: 'GH User' });
    const count = await prisma.user.count({ where: { githubId: `gh-${uniq}` } });
    expect(count).toBe(1);

    // Email yang sudah terverifikasi di SGuard dihubungkan ke akun GitHub.
    const existing = await verifiedToken('gh-link');
    const linked = await auth.loginWithGithub({
      githubId: `gh-link-${uniq}`,
      email: `gh-link-${uniq}@example.com`,
      name: 'Link',
    });
    expect(linked.user.id).toBe(existing.id);

    // Email yang belum terverifikasi tidak boleh dihubungkan diam-diam.
    await request(http())
      .post('/auth/register')
      .send({ name: 'Unverified', email: `gh-unv-${uniq}@example.com`, password: 'rahasia123' })
      .expect(201);
    await expect(
      auth.loginWithGithub({ githubId: `gh-unv-${uniq}`, email: `gh-unv-${uniq}@example.com`, name: 'X' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
