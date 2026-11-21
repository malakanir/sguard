// Menjadikan user sebagai ADMIN. Pemakaian (dari folder backend):
//   npm run admin:promote -- email@contoh.com
const { PrismaClient } = require('@prisma/client');

const email = process.argv[2];
if (!email) {
  console.error('Pemakaian: npm run admin:promote -- <email>');
  process.exit(1);
}

const prisma = new PrismaClient();
prisma.user
  .update({ where: { email: email.toLowerCase() }, data: { role: 'ADMIN' }, select: { email: true, role: true } })
  .then((user) => console.log(`Berhasil: ${user.email} sekarang ${user.role}.`))
  .catch((err) => {
    // P2025: record tidak ditemukan. Error lain (misalnya database tidak terjangkau) ditampilkan apa adanya.
    const lines = String(err.message).trim().split('\n');
    const reason = err.code === 'P2025' ? 'user dengan email tersebut tidak ditemukan.' : lines[lines.length - 1];
    console.error(`Gagal: ${reason}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
