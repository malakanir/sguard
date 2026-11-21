import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { CLOUD_CLIENT, CloudClient } from '../src/sync/cloud-client';

/**
 * Tes terhadap Floci sungguhan (bukan stub). Dijalankan hanya bila FLOCI_TEST=1,
 * dengan FLOCI_ENDPOINT menunjuk ke Floci yang berjalan. Database tetap dari DATABASE_URL.
 */
const enabled = process.env.FLOCI_TEST === '1';

describe.skipIf(!enabled)('Floci sungguhan (e2e)', () => {
  let app: INestApplication;
  let cloud: CloudClient;
  const uniq = Date.now().toString(36);
  const savedSyncMode = process.env.SYNC_MODE;

  beforeAll(async () => {
    process.env.SYNC_MODE = 'floci';
    process.env.EMAIL_VERIFICATION = 'false';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    cloud = app.get(CLOUD_CLIENT);
  });

  afterAll(async () => {
    await app.close();
    if (savedSyncMode === undefined) delete process.env.SYNC_MODE;
    else process.env.SYNC_MODE = savedSyncMode;
  });

  const http = () => app.getHttpServer();

  async function user(label: string) {
    const email = `${label}-${uniq}@example.com`;
    await request(http()).post('/auth/register').send({ name: label, email, password: 'rahasia123' }).expect(201);
    const res = await request(http()).post('/auth/login').send({ email, password: 'rahasia123' }).expect(200);
    return { token: res.body.accessToken as string };
  }

  it('group dan rule tersinkron ke Floci, termasuk egress, rentang port, dan IPv6', async () => {
    const u = await user('floci-sync');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: `floci-${uniq}` }).expect(201);
    expect(group.body.syncStatus).toBe('SYNCED');
    const flociId = group.body.flociGroupId as string;
    expect(flociId).toMatch(/^sg-/);
    expect(flociId).not.toMatch(/^sg-stub-/);

    const https = await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set(auth)
      .send({ name: 'https', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' })
      .expect(201);
    expect(https.body.syncStatus).toBe('SYNCED');

    const range = await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set(auth)
      .send({ name: 'v6-range', protocol: 'tcp', port: 8000, portTo: 8100, cidr: '2001:db8::/48' })
      .expect(201);
    expect(range.body.syncStatus).toBe('SYNCED');

    const egress = await request(http())
      .post(`/groups/${group.body.id}/rules`)
      .set(auth)
      .send({ name: 'db-out', direction: 'EGRESS', protocol: 'tcp', port: 5432, cidr: '10.0.0.0/8' })
      .expect(201);
    expect(egress.body.syncStatus).toBe('SYNCED');

    const described = await cloud.describe(flociId);
    expect(described.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'INGRESS', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0' }),
        expect.objectContaining({ direction: 'INGRESS', protocol: 'tcp', port: 8000, portTo: 8100, cidr: '2001:db8::/48' }),
        expect.objectContaining({ direction: 'EGRESS', protocol: 'tcp', port: 5432, cidr: '10.0.0.0/8' }),
      ]),
    );

    const drift = await request(http()).get(`/groups/${group.body.id}/drift`).set(auth).expect(200);
    expect(drift.body.status).toBe('IN_SYNC');
  });

  it('drift asli terdeteksi (rule dicabut langsung di Floci) dan diperbaiki', async () => {
    const u = await user('floci-drift');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: `drift-${uniq}` }).expect(201);
    const gid = group.body.id as string;
    const flociId = group.body.flociGroupId as string;
    await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: 'ssh-ops', protocol: 'tcp', port: 2222, cidr: '10.1.1.1/32' })
      .expect(201);

    await cloud.revoke(flociId, { protocol: 'tcp', port: 2222, cidr: '10.1.1.1/32' });
    const drifted = await request(http()).get(`/groups/${gid}/drift`).set(auth).expect(200);
    expect(drifted.body.status).toBe('DRIFT');
    expect(drifted.body.missingInCloud).toHaveLength(1);

    const repaired = await request(http()).post(`/groups/${gid}/drift/repair`).set(auth).expect(200);
    expect(repaired.body.status).toBe('IN_SYNC');
    const after = await cloud.describe(flociId);
    expect(after.rules).toContainEqual(expect.objectContaining({ protocol: 'tcp', port: 2222, cidr: '10.1.1.1/32' }));
  });

  it('group yang dihapus langsung di Floci terdeteksi dan dibuat ulang', async () => {
    const u = await user('floci-gone');
    const auth = { Authorization: `Bearer ${u.token}` };
    const group = await request(http()).post('/groups').set(auth).send({ name: `gone-${uniq}` }).expect(201);
    const gid = group.body.id as string;
    await request(http())
      .post(`/groups/${gid}/rules`)
      .set(auth)
      .send({ name: 'web', protocol: 'tcp', port: 80, cidr: '10.2.0.0/16' })
      .expect(201);

    await cloud.deleteGroup(group.body.flociGroupId as string);
    const drift = await request(http()).get(`/groups/${gid}/drift`).set(auth).expect(200);
    expect(drift.body.groupMissingInCloud).toBe(true);

    const repaired = await request(http()).post(`/groups/${gid}/drift/repair`).set(auth).expect(200);
    expect(repaired.body.status).toBe('IN_SYNC');
    const newId = (await request(http()).get(`/groups/${gid}`).set(auth).expect(200)).body.flociGroupId as string;
    expect(newId).not.toBe(group.body.flociGroupId);
    expect((await cloud.describe(newId)).rules).toContainEqual(
      expect.objectContaining({ protocol: 'tcp', port: 80, cidr: '10.2.0.0/16' }),
    );

    await request(http()).delete(`/groups/${gid}`).set(auth).expect(204);
  });
});
