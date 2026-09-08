import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SessionProvider } from '@/lib/session';
import { PreferencesProvider } from '@/lib/preferences';
import AppShell from '@/components/AppShell';
import Telemetry from '@/components/Telemetry';

export const metadata: Metadata = {
  title: 'Carrom Club',
  description:
    'Play carrom online against friends and players worldwide. Skill-based, free to play, with virtual coins only.',
  applicationName: 'Carrom Club',
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#07080d',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // The board is a drag surface; pinch-zoom would fight with aiming.
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <PreferencesProvider>
            <Telemetry />
            <AppShell>{children}</AppShell>
          </PreferencesProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
