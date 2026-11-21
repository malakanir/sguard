#!/usr/bin/env node
// Memeriksa integrasi nyata (AWS/Floci, Slack, SMTP) memakai variabel lingkungan milik Anda.
// Pemakaian (dari folder backend): node --env-file=.env scripts/verify-integrations.mjs
// Tidak pernah mencetak nilai rahasia.
import { DescribeRegionsCommand, EC2Client } from '@aws-sdk/client-ec2';
import * as nodemailer from 'nodemailer';

async function checkAws() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { name: 'AWS/Floci', status: 'SKIP', detail: 'kredensial tidak diset' };
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  const client = new EC2Client({
    region,
    ...(process.env.FLOCI_URL ? { endpoint: process.env.FLOCI_URL } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  const res = await client.send(new DescribeRegionsCommand({}));
  if (!res.Regions?.length) throw new Error('tidak ada region yang dikembalikan');
  return { name: 'AWS/Floci', status: 'PASS', detail: `${res.Regions.length} region terlihat` };
}

async function checkSlack() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { name: 'Slack', status: 'SKIP', detail: 'SLACK_WEBHOOK_URL tidak diset' };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'SGuard integration check' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { name: 'Slack', status: 'PASS', detail: 'pesan uji terkirim' };
}

async function checkSmtp() {
  const to = process.env.VERIFY_EMAIL_TO;
  if (!to) return { name: 'SMTP/Mailpit', status: 'SKIP', detail: 'VERIFY_EMAIL_TO tidak diset' };
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: Number(process.env.SMTP_PORT || 1025),
    secure: false,
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM || 'SGuard <noreply@sguard.local>',
    to,
    subject: 'SGuard integration check',
    text: 'Integration check from verify-integrations.mjs',
  });
  return { name: 'SMTP/Mailpit', status: 'PASS', detail: 'email uji terkirim' };
}

const checks = [
  ['AWS/Floci', checkAws],
  ['Slack', checkSlack],
  ['SMTP/Mailpit', checkSmtp],
];

const results = [];
for (const [name, check] of checks) {
  try {
    results.push(await check());
  } catch (err) {
    results.push({ name, status: 'FAIL', detail: String(err?.message ?? err).slice(0, 200) });
  }
}

for (const result of results) {
  console.log(`${result.status.padEnd(4)}  ${result.name}: ${result.detail}`);
}
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped.`);
process.exit(count('FAIL') > 0 ? 1 : 0);
