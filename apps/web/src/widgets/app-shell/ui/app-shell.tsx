'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { isAdmin, isLeadOrAdmin, logout, useSession } from '@/entities/session';
import { ShiftToggle } from '@/features/shift-toggle';
import { api, unwrap, type NotificationList } from '@/shared/api';
import { useSocket } from '@/shared/socket';
import { Button, Spinner } from '@/shared/ui';

function Bell() {
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => unwrap<NotificationList>(api.GET('/api/v1/notifications')),
    refetchInterval: 60_000,
  });
  const router = useRouter();
  return (
    <details className="relative">
      <summary
        className="cursor-pointer list-none rounded-md px-2 py-1 text-sm hover:bg-white/10"
        aria-label={`Notifications (${data?.unread ?? 0} unread)`}
        data-testid="bell"
      >
        🔔
        {(data?.unread ?? 0) > 0 ? (
          <b className="ml-1 rounded-full bg-red-600 px-1.5 text-xs" data-testid="bell-count">
            {data?.unread}
          </b>
        ) : null}
      </summary>
      <div className="absolute right-0 z-20 mt-1 max-h-80 w-80 overflow-auto rounded-md border border-[var(--line)] bg-[var(--card)] p-2 text-[var(--fg)] shadow-lg">
        {(data?.items ?? []).length === 0 ? (
          <p className="p-2 text-sm text-[var(--muted)]">No notifications.</p>
        ) : null}
        <ul>
          {data?.items.map((n) => (
            <li key={n.id}>
              <button
                className="block w-full rounded p-2 text-left text-sm hover:bg-black/5"
                onClick={() => n.ticketId !== null && router.push(`/tickets/${n.ticketId}`)}
              >
                <b>{n.kind === 'sla_breach' ? 'Overdue' : 'SLA warning'}</b> #
                {String((n.data as { number?: number }).number ?? '')}{' '}
                {String((n.data as { subject?: string }).subject ?? '')}
                {n.read ? null : <span className="ml-1 text-red-600">●</span>}
              </button>
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          onClick={() =>
            void unwrap(api.POST('/api/v1/notifications/read')).then(() =>
              client.invalidateQueries({ queryKey: ['notifications'] }),
            )
          }
        >
          Mark all read
        </Button>
      </div>
    </details>
  );
}

const nav = (pathname: string, href: string): string =>
  pathname === href || (href !== '/' && pathname.startsWith(href))
    ? 'bg-white/20'
    : 'hover:bg-white/10';

/** Header, navigation by role, live connection state and the sign-in guard for every staff page. */
export function AppShell({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { connected } = useSocket();
  useEffect(() => {
    if (session.status === 'anonymous') router.replace('/login');
  }, [session.status, router]);
  if (session.status !== 'authenticated' || session.user === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const link = (href: string, text: string) => (
    <Link href={href} className={`rounded-md px-2 py-1 text-sm ${nav(pathname, href)}`}>
      {text}
    </Link>
  );
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center gap-2 bg-[#1c2330] px-4 py-2 text-white">
        <strong className="mr-2">Helpdesk</strong>
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {link('/', 'My queue')}
          {link('/unassigned', 'Team queue')}
          {link('/search', 'Search')}
          {isLeadOrAdmin(session.user) ? link('/dashboard', 'Dashboard') : null}
          {isLeadOrAdmin(session.user) ? link('/reports', 'Reports') : null}
          {isAdmin(session.user) ? link('/admin', 'Admin') : null}
        </nav>
        <span className="ml-auto flex items-center gap-3 text-sm">
          <span data-testid="live-status" title={connected ? 'Live updates on' : 'Reconnecting…'}>
            {connected ? '● live' : '○ offline'}
          </span>
          <ShiftToggle />
          <Bell />
          <span className="hidden sm:inline">{session.user.name}</span>
          <Button
            variant="secondary"
            onClick={() => void logout().then(() => router.replace('/login'))}
          >
            Sign out
          </Button>
        </span>
      </header>
      <main className="mx-auto max-w-7xl p-4">{children}</main>
    </div>
  );
}
