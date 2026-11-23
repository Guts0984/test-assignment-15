'use client';
import { useQuery } from '@tanstack/react-query';
import { TicketList } from '@/entities/ticket';
import { api, unwrap, type TicketList as TicketListData } from '@/shared/api';
import { ErrorNote, PageTitle, Spinner } from '@/shared/ui';
import { AppShell } from '@/widgets/app-shell';

export function QueuePage() {
  const q = useQuery({
    queryKey: ['queue'],
    queryFn: () =>
      unwrap<TicketListData>(
        api.GET('/api/v1/tickets/queue', { params: { query: { limit: 100 } } }),
      ),
    refetchInterval: 30_000,
  });
  return (
    <AppShell>
      <PageTitle>My queue</PageTitle>
      <p className="mb-3 text-sm text-[var(--muted)]">
        Sorted by SLA deadline. Use ↑ ↓ (or j / k) to move, Enter to open.
      </p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote>Could not load your queue.</ErrorNote>
      ) : (
        <TicketList
          label="My tickets"
          items={q.data.items}
          emptyText="No tickets are assigned to you. Go on shift to receive new ones."
        />
      )}
    </AppShell>
  );
}
