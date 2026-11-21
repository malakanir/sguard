// Mengisi data demo lewat API yang sedang berjalan, supaya alurnya sama dengan pemakaian biasa.
//   cd backend
//   node scripts/seed-demo.js
// Aman dijalankan ulang: user, group, dan rule yang sudah ada dilewati.
// Setelah itu, jadikan admin demo dengan: npm run admin:promote -- demo-admin@example.com

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = 'demo-sguard-123';

async function call(method, path, token, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* tanpa body */
  }
  return { status: res.status, data };
}

async function ensureUser(name, email) {
  await call('POST', '/auth/register', undefined, { name, email, password: PASSWORD });
  const login = await call('POST', '/auth/login', undefined, { email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login ${email} gagal (${login.status}): ${JSON.stringify(login.data)}`);
  return login.data.accessToken;
}

async function ensureGroup(token, name, description) {
  const created = await call('POST', '/groups', token, { name, description });
  if (created.status === 201) {
    console.log(`  + group ${name} (${created.data.syncStatus})`);
    return created.data;
  }
  const list = await call('GET', `/groups?search=${encodeURIComponent(name)}&limit=50`, token);
  const existing = list.data.data.find((g) => g.name === name);
  if (!existing) throw new Error(`group ${name} gagal dibuat: ${JSON.stringify(created.data)}`);
  console.log(`  = group ${name} sudah ada`);
  return existing;
}

async function ensureRule(token, groupId, rule) {
  const res = await call('POST', `/groups/${groupId}/rules`, token, rule);
  if (res.status === 201) console.log(`    + ${rule.name} -> ${res.data.riskLevel}`);
  else if (res.status !== 409) console.log(`    ! ${rule.name} gagal (${res.status}): ${JSON.stringify(res.data)}`);
  return res.status;
}

async function main() {
  console.log(`Mengisi data demo ke ${API}`);

  const alice = await ensureUser('Alice Pratama', 'demo-alice@example.com');
  const bob = await ensureUser('Bob Santoso', 'demo-bob@example.com');
  await ensureUser('Admin Demo', 'demo-admin@example.com');
  const aliceAuth = alice;

  console.log('\nAlice: web-server');
  const web = await ensureGroup(aliceAuth, 'web-server', 'Frontend dan API publik');
  await ensureRule(aliceAuth, web.id, { name: 'HTTPS publik', protocol: 'tcp', port: 443, cidr: '0.0.0.0/0', description: 'Akses web' });
  await ensureRule(aliceAuth, web.id, { name: 'HTTP publik', protocol: 'tcp', port: 80, cidr: '0.0.0.0/0', description: 'Redirect ke HTTPS' });
  await ensureRule(aliceAuth, web.id, { name: 'SSH dari dunia', protocol: 'tcp', port: 22, cidr: '0.0.0.0/0', description: 'Sebaiknya dibatasi' });
  await ensureRule(aliceAuth, web.id, { name: 'Port aplikasi', protocol: 'tcp', port: 8000, portTo: 8100, cidr: '0.0.0.0/0', description: 'Rentang port aplikasi' });

  console.log('\nAlice: database-internal (preset)');
  const db = await ensureGroup(aliceAuth, 'database-internal', 'PostgreSQL dan MySQL untuk jaringan internal');
  const preset = await call('POST', `/groups/${db.id}/presets`, aliceAuth, { presetId: 'db-internal' });
  console.log(`  preset db-internal: ${preset.data.created?.length ?? 0} dibuat, ${preset.data.skipped?.length ?? 0} dilewati`);

  console.log('\nAlice: vpn-access');
  const vpn = await ensureGroup(aliceAuth, 'vpn-access', 'Akses admin lewat VPN');
  await ensureRule(aliceAuth, vpn.id, { name: 'SSH admin VPN', protocol: 'tcp', port: 22, cidr: '10.10.0.5/32', description: 'IP admin' });
  await ensureRule(aliceAuth, vpn.id, { name: 'Monitoring IPv6', protocol: 'tcp', port: 9100, cidr: '2001:db8::/48', description: 'Node exporter' });
  await ensureRule(aliceAuth, vpn.id, { name: 'Database keluar', direction: 'EGRESS', protocol: 'tcp', port: 5432, cidr: '10.0.0.0/8', description: 'Koneksi ke database' });

  console.log('\nBob: app-backend');
  const backend = await ensureGroup(bob, 'app-backend', 'Layanan backend');
  await ensureRule(bob, backend.id, { name: 'API internal', protocol: 'tcp', port: 3000, cidr: '10.0.0.0/8', description: 'API internal' });
  await ensureRule(bob, backend.id, { name: 'Redis internal', protocol: 'tcp', port: 6379, cidr: '10.0.0.0/8', description: 'Cache' });
  await ensureRule(bob, backend.id, { name: 'Redis publik', protocol: 'tcp', port: 6379, cidr: '0.0.0.0/0', description: 'Salah konfigurasi' });

  console.log('\nBerbagi group');
  const bobUser = await call('GET', '/auth/me', bob);
  const share1 = await call('POST', `/groups/${web.id}/members`, aliceAuth, { email: 'demo-bob@example.com', role: 'EDITOR' });
  const share2 = await call('POST', `/groups/${vpn.id}/members`, aliceAuth, { email: 'demo-bob@example.com', role: 'VIEWER' });
  console.log(`  web-server -> Bob (EDITOR): ${share1.status}, vpn-access -> Bob (VIEWER): ${share2.status}`);
  console.log(`  (akun Bob: ${bobUser.data.email})`);

  console.log('\nScan drift');
  for (const g of [web, db, vpn]) {
    const scan = await call('POST', `/groups/${g.id}/scan`, aliceAuth);
    console.log(`  ${g.name}: ${scan.data?.status ?? scan.status}`);
  }

  console.log('\nSelesai. Akun demo (password sama untuk semua):');
  console.log(`  demo-alice@example.com  (pemilik web-server, database-internal, vpn-access)`);
  console.log(`  demo-bob@example.com    (pemilik app-backend; EDITOR di web-server, VIEWER di vpn-access)`);
  console.log(`  demo-admin@example.com  (jadikan ADMIN dengan: npm run admin:promote -- demo-admin@example.com)`);
  console.log(`  Password: ${PASSWORD}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
