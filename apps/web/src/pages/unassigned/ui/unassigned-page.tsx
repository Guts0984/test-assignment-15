'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TicketList } from '@/entities/ticket';
import { api, unwrap, type TicketList as TicketListData } from '@/shared/api';
import { ErrorNote, PageTitle, Spinner } from '@/shared/ui';
import { AppShell } from '@/widgets/app-shell';

export function UnassignedPage() {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ['unassigned'],
    queryFn: () =>
      unwrap<TicketListData>(
        api.GET('/api/v1/tickets/unassigned', { params: { query: { limit: 100 } } }),
      ),
    refetchInterval: 30_000,
  });
  return (
    <AppShell>
      <PageTitle>Team queue (no owner yet)</PageTitle>
      <p className="mb-3 text-sm text-[var(--muted)]">Press t on the selected ticket to take it.</p>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorNote>Could not load the team queue.</ErrorNote>
      ) : (
        <TicketList
          label="Unassigned tickets"
          items={q.data.items}
          emptyText="The queue is empty."
          onTake={(t) =>
            void unwrap(
              api.POST('/api/v1/tickets/{id}/take', { params: { path: { id: t.id } } }),
            ).finally(() => client.invalidateQueries())
          }
        />
      )}
    </AppShell>
  );
}
