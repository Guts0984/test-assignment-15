'use client';
import { AppShell } from '@/widgets/app-shell';
import { TicketView } from '@/widgets/ticket-view';

export function TicketPage({ ticketId }: { ticketId: string }) {
  return (
    <AppShell>
      <TicketView ticketId={ticketId} />
    </AppShell>
  );
}
