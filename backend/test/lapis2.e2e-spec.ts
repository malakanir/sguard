import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { CLOUD_CLIENT, StubCloudClient } from '../src/sync/cloud-client';

/** Test ini memakai database dari DATABASE_URL dan cloud stub di memori. */
describe('Lapis 2 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cloud = new StubCloudClient();
  const uniq = Date.now().toString(36);

  async function register(label: string) {
    const email = `${label}-${uniq}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: 'rahasia123' })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'rahasia123' })
      .expect(200);
    return { id: login.body.user.id as string, email, token: login.body.accessToken as string, refresh: login.body.refreshToken as string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLOUD_CLIENT)
      .useValue(cloud)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => app.getHttpServer();

  it('FR-16: refresh token dirotasi dan logout mencabut sesi', async () => {
    const u = await register('refresh');
    const first = await request(http()).post('/auth/refresh').send({ refreshToken: u.refresh }).expect(200);
    expect(first.body.refreshToken).toBeTruthy();
    expect(first.body.refreshToken).not.toBe(u.refresh);

    // Token lama sudah tidak berlaku setelah rotasi.
    await request(http()).post('/auth/refresh').send({ refreshToken: u.refresh }).expect(401);

    await request(http())
      .post('/auth/logout')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(204);
    await request(http()).post('/auth/refresh').send({ refreshToken: first.body.refreshToken }).expect(401);
  });

  it('FR-13: audit log mencatat create, update, delete dengan isi sebelum dan sesudah, hanya milik sendiri', async () => {
    const u = await register('audit');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: 'audit-grp' }).expect(201);
    const gid = group.body.id as string;

    const rule = await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: 'web', protocol: 'tcp', port: 8443, cidr: '10.0.0.0/8' })
      .expect(201);
    const rid = rule.body.id as string;
    await request(http()).patch(`/rules/${rid}`).set(auth).send({ cidr: '0.0.0.0/0' }).expect(200);
    await request(http()).delete(`/rules/${rid}`).set(auth).expect(204);

    const audit = await request(http()).get(`/audit?groupId=${gid}`).set(auth).expect(200);
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['DELETE', 'UPDATE', 'CREATE']);
    const update = audit.body.data.find((e: { action: string }) => e.action === 'UPDATE');
    expect(update.before.cidr).toBe('10.0.0.0/8');
    expect(update.after.cidr).toBe('0.0.0.0/0');

    // User lain tidak melihat audit ini.
    const other = await register('audit-other');
    const res = await request(http()).get(`/audit?groupId=${gid}`).set('Authorization', `Bearer ${other.token}`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('FR-14: preset diterapkan, dan dijalankan ulang tidak membuat duplikat', async () => {
    const u = await register('preset');
    const auth = { Authorization: `Bearer ${u.token}` };
    const gid = (await request(http()).post('/groups').set(auth).send({ name: 'preset-grp' }).expect(201)).body.id as string;

    const list = await request(http()).get('/presets').set(auth).expect(200);
    expect(list.body.map((p: { id: string }) => p.id)).toEqual(['web-server', 'ssh-admin', 'db-internal']);

    const first = await request(http()).post(`/groups/${gid}/presets`).set(auth).send({ presetId: 'web-server' }).expect(200);
    expect(first.body.created).toEqual(['HTTP', 'HTTPS']);
    const second = await request(http()).post(`/groups/${gid}/presets`).set(auth).send({ presetId: 'web-server' }).expect(200);
    expect(second.body.skipped).toEqual(['HTTP', 'HTTPS']);

    await request(http()).post(`/groups/${gid}/presets`).set(auth).send({ presetId: 'nope' }).expect(400);
  });

  it('FR-15: ekspor CSV dan JSON hanya berisi data milik user, dan aman dari CSV injection', async () => {
    const u = await register('export');
    const auth = { Authorization: `Bearer ${u.token}` };
    const gid = (await request(http()).post('/groups').set(auth).send({ name: 'export-grp' }).expect(201)).body.id as string;
    await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: '=HYPERLINK("x")', protocol: 'tcp', port: 22, cidr: '0.0.0.0/0' })
      .expect(201);

    const csv = await request(http()).get('/reports/export?format=csv').set(auth).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain('riskLevel');
    expect(lines[1]).toContain('"\'=HYPERLINK(""x"")"');

    const json = await request(http()).get(`/reports/export?format=json&groupId=${gid}`).set(auth).expect(200);
    expect(json.body.count).toBe(1);
    expect(json.body.rules[0].riskLevel).toBe('HIGH');

    await request(http()).get('/reports/export?format=xml').set(auth).expect(400);
    const other = await register('export-other');
    await request(http())
      .get(`/reports/export?format=json&groupId=${gid}`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(404);
  });

  it('FR-17: endpoint admin 403 untuk USER, dan hanya agregat untuk ADMIN', async () => {
    const user = await register('rbac-user');
    const owner = await register('rbac-owner');
    const ownerAuth = { Authorization: `Bearer ${owner.token}` };
    const gid = (await request(http()).post('/groups').set(ownerAuth).send({ name: 'secret-grp' }).expect(201)).body.id as string;
    await request(http())
      .post(`/groups/${gid}/rules`)
      .set(ownerAuth)
      .send({ name: 'rahasia-rule', protocol: 'tcp', port: 9000, cidr: '10.1.2.3/32' })
      .expect(201);

    await request(http()).get('/admin/summary').set('Authorization', `Bearer ${user.token}`).expect(403);

    await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
    const summary = await request(http()).get('/admin/summary').set('Authorization', `Bearer ${user.token}`).expect(200);
    expect(summary.body.totalRules).toBeGreaterThan(0);
    expect(JSON.stringify(summary.body)).not.toContain('rahasia-rule');

    const users = await request(http()).get('/admin/users?limit=50').set('Authorization', `Bearer ${user.token}`).expect(200);
    const ownerRow = users.body.data.find((row: { id: string }) => row.id === owner.id);
    expect(ownerRow.groupCount).toBeGreaterThan(0);
    expect(ownerRow.ruleCount).toBeGreaterThan(0);
    expect(JSON.stringify(users.body)).not.toContain('rahasia-rule');
  });

  it('FR-18: drift terdeteksi (rule hilang dan rule asing) lalu diperbaiki lewat sync ulang', async () => {
    const u = await register('drift');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: 'drift-grp' }).expect(201);
    const gid = group.body.id as string;
    const flociId = group.body.flociGroupId as string;
    expect(group.body.syncStatus).toBe('SYNCED');

    const https = await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: 'HTTPS', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' })
      .expect(201);

    const clean = await request(http()).get(`/groups/${gid}/drift`).set(auth).expect(200);
    expect(clean.body.status).toBe('IN_SYNC');

    // Perubahan di luar SGuard: rule 443 dihapus, dan rule 8080 ditambahkan.
    await cloud.revoke(flociId, { protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' });
    await cloud.authorize(flociId, { protocol: 'tcp', port: 8080, cidr: '0.0.0.0/0' });

    const drifted = await request(http()).get(`/groups/${gid}/drift`).set(auth).expect(200);
    expect(drifted.body.status).toBe('DRIFT');
    expect(drifted.body.missingInCloud.map((r: { id: string }) => r.id)).toContain(https.body.id);
    expect(drifted.body.extraInCloud).toEqual([
      expect.objectContaining({ protocol: 'tcp', port: 8080, cidr: '0.0.0.0/0' }),
    ]);

    const repaired = await request(http()).post(`/groups/${gid}/drift/repair`).set(auth).expect(200);
    expect(repaired.body.status).toBe('IN_SYNC');
    const cloudRules = (await cloud.describe(flociId)).rules;
    expect(cloudRules).toEqual([expect.objectContaining({ protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' })]);

    const other = await register('drift-other');
    await request(http()).get(`/groups/${gid}/drift`).set('Authorization', `Bearer ${other.token}`).expect(404);
  });
});
