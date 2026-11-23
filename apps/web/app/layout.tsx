import type { ReactNode } from 'react';
import { Providers } from '@/app';
import './globals.css';

export const metadata = { title: 'Helpdesk', description: 'Customer support desk' };
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
