'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '@/entities/session';
import { api, unwrap, type Dashboard, type Directory } from '@/shared/api';
import { Card, ErrorNote, Spinner } from '@/shared/ui';
import { TicketList } from '@/entities/ticket';

/** Live view for team leads: agent load, tickets without an owner, at risk, overdue. Updated by socket events. */
export function LeadDashboard() {
  const session = useSession();
  const dir = useQuery({
    queryKey: ['directory'],
    queryFn: () => unwrap<Directory>(api.GET('/api/v1/directory')),
    staleTime: 60_000,
  });
  const leadTeams = (dir.data?.teams ?? []).filter(
    (t) =>
      session.user?.role === 'admin' ||
      session.user?.memberships.some((m) => m.teamId === t.id && m.role === 'lead'),
  );
  const [picked, setPicked] = useState<string>('');
  const teamId = picked !== '' ? picked : (leadTeams[0]?.id ?? '');
  const dash = useQuery({
    queryKey: ['dashboard', teamId],
    enabled: teamId !== '',
    queryFn: () =>
      unwrap<Dashboard>(
        api.GET('/api/v1/dashboard/teams/{teamId}', { params: { path: { teamId } } }),
      ),
    refetchInterval: 30_000,
  });
  if (dir.isPending) return <Spinner />;
  if (leadTeams.length === 0)
    return <ErrorNote>The dashboard is for team leads and administrators.</ErrorNote>;
  const d = dash.data;
  return (
    <div className="space-y-4" data-testid="lead-dashboard">
      <label className="flex items-center gap-2 text-sm">
        <span className="font-medium">Team</span>
        <select
          className="rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-1"
          value={teamId}
          onChange={(e) => setPicked(e.target.value)}
          data-testid="dashboard-team"
        >
          {leadTeams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {d === undefined ? (
        <Spinner />
      ) : (
        <>
          <section aria-label="Agent load">
            <h2 className="mb-2 font-semibold">Agent load</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {d.agents.map((a) => (
                <li
                  key={a.id}
                  data-testid="agent-load"
                  data-agent-id={a.id}
                  className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-2 text-sm"
                >
                  <b>{a.name}</b>{' '}
                  <span className={a.onShift ? 'text-green-600' : 'text-[var(--muted)]'}>
                    {a.onShift ? '● on shift' : '○ off'}
                  </span>
                  <div
                    className="mt-1 h-2 rounded bg-black/10"
                    role="progressbar"
                    aria-valuenow={a.openCount}
                    aria-valuemax={a.ticketLimit}
                    aria-label={`${a.name} load`}
                  >
                    <div
                      className="h-2 rounded bg-brand"
                      style={{
                        width: `${a.ticketLimit === 0 ? 0 : Math.min(100, (a.openCount / a.ticketLimit) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="text-xs">
                    {a.openCount} / {a.ticketLimit}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <Card>
            <h2 className="mb-2 font-semibold">
              Waiting in the team queue (
              <span data-testid="unassigned-count">{d.unassignedCount}</span>)
            </h2>
            <TicketList
              label="Unassigned tickets"
              items={d.unassigned}
              emptyText="Nothing is waiting."
            />
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">
              At risk of breaching (<span data-testid="at-risk-count">{d.atRisk.length}</span>)
            </h2>
            <TicketList
              label="Tickets at risk"
              items={d.atRisk}
              emptyText="No ticket is at risk."
            />
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">
              Overdue (<span data-testid="overdue-count">{d.overdue.length}</span>)
            </h2>
            <TicketList label="Overdue tickets" items={d.overdue} emptyText="Nothing is overdue." />
          </Card>
        </>
      )}
    </div>
  );
}
