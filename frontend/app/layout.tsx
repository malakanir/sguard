import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SGuard · Security Group Manager',
  description: 'Kelola, audit, dan simulasikan aturan security group dengan aman.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body className="bg-slate-50 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
