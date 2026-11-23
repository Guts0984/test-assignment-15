'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MANUAL_STATUSES, PRIORITY_LABEL, STATUS_LABEL } from '@/entities/ticket';
import { api, isApiCallError, unwrap, type Directory, type TicketDetail } from '@/shared/api';
import { messageForCode } from '@/shared/lib';
import { Button, ErrorNote, TextInput } from '@/shared/ui';

type Props = {
  ticket: TicketDetail['ticket'];
  directory: Directory | undefined;
  meId: string;
  canClose: boolean;
};

const selectClass =
  'w-full rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-sm';

/** Status, priority, team, transfer, take and merge for one ticket. The server decides what is allowed. */
export function TicketActions({ ticket, directory, meId, canClose }: Props) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [mergeNumber, setMergeNumber] = useState('');
  const path = { params: { path: { id: ticket.id } } };
  const done = async (): Promise<void> => {
    setError(null);
    await client.invalidateQueries({ queryKey: ['ticket', ticket.id] });
    void client.invalidateQueries({ queryKey: ['queue'] });
  };
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await done();
    } catch (e) {
      setError(isApiCallError(e) ? messageForCode(e.code, e.message) : 'Cannot reach the server.');
    }
  };
  const closed = ticket.status === 'closed';
  const colleagues = (directory?.agents ?? []).filter(
    (a) => a.teamId === ticket.teamId && a.role === 'agent',
  );
  const statuses =
    canClose && ticket.status === 'resolved'
      ? [...MANUAL_STATUSES, 'closed' as const]
      : [...MANUAL_STATUSES];

  const merge = async (): Promise<void> => {
    const found = await unwrap<{ items: { id: string; number: number }[] }>(
      api.GET('/api/v1/search', { params: { query: { q: `#${mergeNumber}` } } }),
    );
    const target = found.items.find((i) => String(i.number) === mergeNumber.replace('#', ''));
    if (target === undefined)
      throw Object.assign(new Error('No ticket with that number in your teams.'), {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'No ticket with that number in your teams.' },
        },
      });
    await unwrap(
      api.POST('/api/v1/tickets/{id}/merge', { ...path, body: { targetTicketId: target.id } }),
    );
    setMergeNumber('');
  };

  return (
    <div className="space-y-3 text-sm" data-testid="ticket-actions">
      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
      {ticket.assigneeId === null && !closed ? (
        <Button
          onClick={() => void run(() => unwrap(api.POST('/api/v1/tickets/{id}/take', path)))}
          data-testid="take"
        >
          Take this ticket
        </Button>
      ) : null}
      <label className="block">
        <span className="mb-1 block font-medium">Status</span>
        <select
          className={selectClass}
          disabled={closed}
          value={ticket.status}
          data-testid="status-select"
          onChange={(e) =>
            void run(() =>
              unwrap(
                api.PUT('/api/v1/tickets/{id}/status', {
                  ...path,
                  body: { status: e.target.value as 'open' },
                }),
              ),
            )
          }
        >
          {!statuses.includes(ticket.status as never) ? (
            <option value={ticket.status}>{STATUS_LABEL[ticket.status]}</option>
          ) : null}
          {statuses.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">Priority</span>
        <select
          className={selectClass}
          disabled={closed}
          value={ticket.priority}
          data-testid="priority-select"
          onChange={(e) =>
            void run(() =>
              unwrap(
                api.PUT('/api/v1/tickets/{id}/priority', {
                  ...path,
                  body: { priority: e.target.value as 'high' },
                }),
              ),
            )
          }
        >
          {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">Team</span>
        <select
          className={selectClass}
          disabled={closed}
          value={ticket.teamId}
          data-testid="team-select"
          onChange={(e) =>
            void run(() =>
              unwrap(
                api.PUT('/api/v1/tickets/{id}/team', { ...path, body: { teamId: e.target.value } }),
              ),
            )
          }
        >
          {(directory?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">Assign to colleague</span>
        <select
          className={selectClass}
          disabled={closed || ticket.status === 'resolved'}
          value=""
          data-testid="transfer-select"
          onChange={(e) =>
            e.target.value !== '' &&
            void run(() =>
              unwrap(
                api.POST('/api/v1/tickets/{id}/transfer', {
                  ...path,
                  body: { assigneeId: e.target.value },
                }),
              ),
            )
          }
        >
          <option value="">{ticket.assigneeName ?? 'Unassigned'} (choose to transfer)</option>
          {colleagues
            .filter((a) => a.id !== ticket.assigneeId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.id === meId ? ' (me)' : ''}
                {a.onShift ? '' : ' — off shift'}
              </option>
            ))}
        </select>
      </label>
      {!closed ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(merge);
          }}
        >
          <label className="flex-1">
            <span className="mb-1 block font-medium">Merge into ticket #</span>
            <TextInput
              id="merge-number"
              inputMode="numeric"
              value={mergeNumber}
              onChange={(e) => setMergeNumber(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="100123"
              data-testid="merge-number"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={mergeNumber.length < 4}
            data-testid="merge"
          >
            Merge
          </Button>
        </form>
      ) : null}
    </div>
  );
}
