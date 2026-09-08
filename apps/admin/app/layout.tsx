import type { Metadata } from 'next';
import './globals.css';
import { AdminProvider } from '@/lib/admin';
import Shell from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Carrom Club — Admin',
  description: 'Moderation, anti-cheat review and operations.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AdminProvider>
          <Shell>{children}</Shell>
        </AdminProvider>
      </body>
    </html>
  );
}
