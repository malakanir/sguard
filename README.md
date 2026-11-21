# SGuard: Security Group Rule Manager & Auditor

Aplikasi web untuk mengelola, mengaudit, dan mensimulasikan rule security group AWS. Data disimpan di PostgreSQL, lalu disalin ke Floci (emulator AWS lokal), sehingga demo berjalan tanpa akun AWS.

Stack: **Next.js** (frontend), **NestJS** (REST API), **PostgreSQL** + **Prisma** (database), **JWT** + bcrypt (auth), **AWS SDK v3 EC2** ke **Floci** (sync), **docker compose** (PostgreSQL, Floci, Mailpit).

## Prasyarat

- Node.js 20 atau lebih baru
- Docker dan Docker Compose

## Menjalankan

```bash
# 1. Infrastruktur: PostgreSQL, Floci, Mailpit
cp .env.example .env
docker compose up -d

# 2. Backend (port 4000)
cd backend
cp .env.example .env          # ganti JWT_SECRET dengan string acak
npm install
npx prisma migrate deploy     # buat tabel
npm run start:dev

# 3. Frontend (port 3000), di terminal lain
cd frontend
cp .env.example .env.local    # hanya bila API tidak di localhost:4000
npm install
npm run dev
```

Buka <http://localhost:3000>, daftar akun, lalu mulai dari halaman Security Groups.

## Skenario demo (3-5 menit)

1. Register, lalu login.
2. Buat group `web-server`.
3. Tambah rule TCP 443 dari `0.0.0.0/0` (LOW), lalu TCP 22 dari `0.0.0.0/0` (HIGH, lengkap dengan alasan dan saran).
4. Buka simulator: SSH dari `8.8.8.8` menghasilkan ALLOW.
5. Ubah CIDR rule SSH menjadi `10.0.0.5/32`. Simulator yang sama sekarang menghasilkan DENY.
6. Buka dashboard, filter HIGH, dan lihat ringkasan per group.

## Mode sinkronisasi

- `SYNC_MODE=floci` (default): group dan rule dikirim ke Floci lewat AWS SDK v3.
- `SYNC_MODE=stub`: sync disimulasikan di memori, untuk deployment server tanpa Floci.

Jika Floci tidak terjangkau, data tetap tersimpan dengan status `FAILED` dan pesan singkat. Coba lagi dengan tombol "Sync ulang" setelah Floci berjalan.

## Fitur Lapis 3

- **Realtime WebSocket** (FR-20): namespace `/events`. JWT dikirim saat handshake (`auth.token`). Event `rule.high` saat rule HIGH dibuat atau diubah menjadi HIGH, dan `sync.changed` saat status sync group atau rule berubah. Event hanya dikirim ke pemilik data. Frontend menampilkannya sebagai toast.
- **Verifikasi email** (FR-22): nonaktif secara default (`EMAIL_VERIFICATION=true` untuk mengaktifkan). Tautan verifikasi berlaku 24 jam dan hanya sekali pakai. Dengan `MAIL_TRANSPORT=smtp`, email dikirim ke Mailpit; buka http://localhost:8025 untuk melihatnya.
- **Login GitHub** (FR-21): aktif jika `GITHUB_CLIENT_ID` diisi. Buat OAuth app di GitHub dengan callback `http://localhost:4000/auth/github/callback`. Akun GitHub dengan email yang sudah dipakai hanya dihubungkan bila email tersebut sudah terverifikasi di SGuard. Token dikirim ke frontend lewat fragment URL (`#`), bukan query string.
- **sync-worker** (FR-23): service NestJS terpisah lewat TCP. Mode dipilih dengan `SYNC_TRANSPORT`.

### Menjalankan sync-worker

```bash
# Terminal 1: worker
cd backend
npm run build
npm run start:worker

# Terminal 2: API yang meneruskan sinkronisasi ke worker
cd backend
SYNC_TRANSPORT=tcp npm run start:prod
```

Di Windows PowerShell, atur variabel dengan `$env:SYNC_TRANSPORT="tcp"` sebelum menjalankan perintah.

### Test

```bash
cd backend
npm run test:e2e
```

Test memakai PostgreSQL dari `DATABASE_URL`. Test Lapis 3 menjalankan sync-worker dalam proses yang sama, dengan cloud stub.

## Fitur Lapis 2

- **Refresh token dan logout** (FR-16): access token 15 menit, refresh token 7 hari, dirotasi setiap dipakai, disimpan sebagai hash. Logout mencabut refresh token.
- **Audit log** (FR-13): setiap create, update, dan delete rule dicatat dengan isi sebelum dan sesudah. Tabel hanya bisa ditambah. Lihat di `GET /audit` atau tab riwayat di halaman group.
- **Preset rule** (FR-14): Web server, SSH admin, Database internal. Ditambahkan lewat `POST /groups/:id/presets`. Rule yang sudah ada dilewati.
- **Ekspor laporan** (FR-15): `GET /reports/export?format=csv|json&groupId=`. Hanya data milik sendiri, dan sel yang diawali `=`, `+`, `-`, `@` diberi apostrof agar aman dibuka di spreadsheet.
- **RBAC** (FR-17): role `USER` dan `ADMIN`. Endpoint `/admin/*` hanya mengembalikan agregat, tanpa isi rule user lain. Role dicek ulang dari database.
- **Drift detection** (FR-18): `GET /groups/:id/drift` membandingkan database dengan Floci. `POST /groups/:id/drift/repair` mencabut rule asing dan mengirim ulang rule yang hilang. Rule di luar cakupan Fase 1 (rentang port, dan lainnya) hanya dilaporkan, tidak diubah.
- **Deployment** (FR-19, bonus): `backend/Dockerfile` dan `frontend/Dockerfile`. Belum dipublikasikan ke platform hosting manapun.

### Menjadikan admin

```bash
cd backend
npm run admin:promote -- email@contoh.com
```

### Test

```bash
cd backend
npm run test:e2e
```

Test memakai database dari `DATABASE_URL` dan cloud stub di memori, jadi tidak butuh Floci.

## Fitur Fase 2

- **Rate limit login** (FR-25): maksimal 5 percobaan gagal per 15 menit untuk satu kombinasi IP dan email. Balasan 429 memuat perkiraan waktu tunggu.
- **Scan drift terjadwal** (FR-25): `SCAN_INTERVAL_MINUTES` menjalankan pemeriksaan drift untuk semua group. Manual: `POST /groups/:id/scan`. Status terakhir tampil di detail group. Event `drift.detected` hanya dikirim saat status berubah menjadi DRIFT.
- **Rule egress, rentang port, IPv6, CIDR lebar** (FR-24): field `direction` (INGRESS atau EGRESS), `portTo` untuk rentang port, dan CIDR IPv4 atau IPv6. Rentang yang mencakup port sensitif dan terbuka ke internet dinilai HIGH. CIDR IPv4 /8 atau lebih lebar dinilai MEDIUM. Simulator juga memahami arah, rentang, dan IPv6.

## Fitur Fase 3

- **Berbagi group** (FR-27): `POST /groups/:id/members` dengan peran VIEWER (hanya baca) atau EDITOR (boleh mengubah rule dan sync). Hanya pemilik yang bisa membagikan atau menghapus group. Non-member mendapat 404. Member bisa keluar sendiri.
- **Notifikasi** (FR-28): channel email, Slack, dan webhook di `/notifications/channels`. Event: `rule.high`, `sync.failed`, dan `drift.detected`. Target dan secret disimpan terenkripsi. Webhook dikirim dengan header Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` berupa `v1,<HMAC-SHA256 base64>` atas `id.timestamp.body`). Target webhook harus https, dan alamat privat atau loopback ditolak.
- **Akun AWS** (FR-26): `/aws-accounts` menyimpan access key dan secret terenkripsi (AES-256-GCM dengan `CREDENTIAL_ENCRYPTION_KEY`). Secret tidak pernah dikembalikan ke klien. Akun yang masih dipakai group tidak bisa dihapus. Uji koneksi memanggil EC2 DescribeRegions.

### Catatan dan batasan

- Rate limit disimpan di memori proses. Dengan banyak instance, diperlukan penyimpanan bersama (Redis).
- Kunci enkripsi ada di environment. Untuk produksi, kunci sebaiknya dikelola KMS atau Vault. Belum ada rotasi kunci.
- Webhook memeriksa DNS saat dikirim, tetapi tidak mencegah DNS rebinding sepenuhnya. Itu memerlukan pinning alamat di lapisan HTTP.
- Kredensial AWS belum mendukung STS AssumeRole, dan belum ada pilihan akun per group setelah dibuat.
- Pengiriman email sudah diverifikasi lewat SMTP (server uji lokal, bukan Mailpit). Slack dan AWS sungguhan belum diverifikasi, karena butuh webhook dan kredensial milik Anda.
- Export laporan (FR-15) tetap hanya data milik sendiri, sesuai PRD. Anggota group yang dibagikan tidak ikut diekspor.

## Verifikasi terhadap Floci

Tes di `backend/test/floci.e2e-spec.ts` berjalan melawan Floci sungguhan (image `floci/floci`, port 4566) dan lulus: sinkronisasi group dan rule (termasuk egress, rentang port, dan IPv6), deteksi drift asli, dan pembuatan ulang group yang dihapus di Floci.

```bash
cd backend
FLOCI_TEST=1 npm run test:e2e -- test/floci.e2e-spec.ts
```

Tes ini dilewati bila `FLOCI_TEST` tidak diatur.

## Verifikasi integrasi (tanpa AWS)

- **GitHub OAuth (FR-21)** diuji terhadap server GitHub tiruan lokal (`GITHUB_OAUTH_BASE` dan `GITHUB_API_BASE` diarahkan ke sana): redirect otorisasi, pertukaran kode, profil, email terverifikasi, dan pengalihan dengan token di fragment. Sudah diuji protokolnya dan sudah diuji login dengan GitHub sungguhan (OAuth App lokal).
- **Slack (FR-28)** diuji terhadap webhook tiruan lokal (`SLACK_WEBHOOK_HOST` untuk pengujian saja): payload JSON {text} dan pencatatan kegagalan. Belum diuji dengan Slack sungguhan.
- **Email (FR-28)** diuji lewat SMTP lokal dengan `MAIL_TRANSPORT=smtp`.
- Jalankan: `cd backend && npm run test:e2e` (termasuk `test/integrations.e2e-spec.ts`).

## Status

- Lapis 1 (inti): selesai.
- Lapis 2 (FR-13 sampai FR-19): selesai.
- Lapis 3 (FR-20 sampai FR-23): selesai, dengan verifikasi terbatas pada stub dan worker lokal.
- Fase 2 (FR-24, FR-25): selesai.
- Fase 3 (FR-26, FR-27, FR-28): selesai. Terverifikasi: AWS (lewat Floci), email (SMTP), dan protokol GitHub OAuth serta Slack (lewat server tiruan). Belum diverifikasi dengan layanan sungguhan: AWS. GitHub dan Slack sudah diuji dengan layanan sungguhan.

Rujukan lengkap ada di PRD (`../PRD SGuard Security Group Rule Manager & Auditor.md`).
