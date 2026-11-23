'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AgentForm, HolidayForm, MailboxForm, RuleForm, TeamForm } from '@/features/admin-forms';
import {
  api,
  unwrap,
  type AgentView,
  type Directory,
  type FailedJob,
  type Holiday,
  type Mailbox,
  type RoutingRule,
  type TeamView,
} from '@/shared/api';
import { Badge, Button, Card, Spinner } from '@/shared/ui';

const TABS = ['teams', 'agents', 'rules', 'mailboxes', 'jobs'] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  teams: 'Teams & hours',
  agents: 'Agents',
  rules: 'Routing rules',
  mailboxes: 'Mailboxes',
  jobs: 'Failed jobs',
};
const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function Holidays({ team }: { team: TeamView }) {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'holidays', team.id],
    queryFn: () =>
      unwrap<Holiday[]>(
        api.GET('/api/v1/admin/teams/{id}/holidays', { params: { path: { id: team.id } } }),
      ),
  });
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-sm">Holidays ({q.data?.length ?? '…'})</summary>
      <ul className="my-2 flex flex-wrap gap-2 text-xs">
        {(q.data ?? []).map((h) => (
          <li key={h.id} className="rounded-full bg-black/10 px-2 py-0.5">
            {h.date} {h.name}{' '}
            <button
              aria-label={`Remove ${h.name}`}
              onClick={() =>
                void unwrap(
                  api.DELETE('/api/v1/admin/teams/{id}/holidays/{holidayId}', {
                    params: { path: { id: team.id, holidayId: h.id } },
                  }),
                ).then(() => client.invalidateQueries({ queryKey: ['admin', 'holidays', team.id] }))
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <HolidayForm teamId={team.id} />
    </details>
  );
}

export function AdminPanels() {
  const [tab, setTab] = useState<Tab>('teams');
  const client = useQueryClient();
  const dir = useQuery({
    queryKey: ['directory'],
    queryFn: () => unwrap<Directory>(api.GET('/api/v1/directory')),
  });
  const teams = useQuery({
    queryKey: ['admin', 'teams'],
    queryFn: () => unwrap<TeamView[]>(api.GET('/api/v1/admin/teams')),
  });
  const agents = useQuery({
    queryKey: ['admin', 'agents'],
    enabled: tab === 'agents',
    queryFn: () => unwrap<AgentView[]>(api.GET('/api/v1/admin/agents')),
  });
  const rules = useQuery({
    queryKey: ['admin', 'rules'],
    enabled: tab === 'rules',
    queryFn: () => unwrap<RoutingRule[]>(api.GET('/api/v1/admin/routing-rules')),
  });
  const boxes = useQuery({
    queryKey: ['admin', 'mailboxes'],
    enabled: tab === 'mailboxes',
    queryFn: () => unwrap<Mailbox[]>(api.GET('/api/v1/admin/mailboxes')),
  });
  const jobs = useQuery({
    queryKey: ['admin', 'jobs'],
    enabled: tab === 'jobs',
    queryFn: () => unwrap<FailedJob[]>(api.GET('/api/v1/admin/jobs/failed')),
    refetchInterval: 15_000,
  });
  const teamName = (id: string): string =>
    teams.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8);
  return (
    <div className="space-y-4" data-testid="admin">
      <div role="tablist" aria-label="Administration" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md border px-3 py-1 text-sm ${tab === t ? 'border-brand bg-brand/10 font-medium' : 'border-[var(--line)]'}`}
          >
            {LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'teams' ? (
        <>
          <Card>
            <h2 className="mb-2 font-semibold">New team</h2>
            <TeamForm />
          </Card>
          {teams.isPending ? (
            <Spinner />
          ) : (
            teams.data?.map((t) => (
              <Card key={t.id}>
                <h3 className="font-semibold" data-testid="team-name">
                  {t.name}
                </h3>
                <p className="text-sm text-[var(--muted)]">
                  {t.timeZone} · {t.workdays.map((d) => DAYS[d]).join(', ')} · {t.workStart}–
                  {t.workEnd} · default language {t.defaultLanguage}
                </p>
                <Holidays team={t} />
              </Card>
            ))
          )}
        </>
      ) : null}
      {tab === 'agents' ? (
        <>
          <Card>
            <h2 className="mb-2 font-semibold">Add agent</h2>
            <AgentForm directory={dir.data} />
          </Card>
          <Card>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-[var(--muted)]">
                  <th>Name</th>
                  <th>Email</th>
                  <th>Teams</th>
                  <th>Limit</th>
                  <th>Load</th>
                  <th>Languages</th>
                </tr>
              </thead>
              <tbody>
                {agents.data?.map((a) => (
                  <tr key={a.id} className="border-t border-[var(--line)]">
                    <td>
                      {a.name}
                      {a.active ? '' : ' (inactive)'}
                    </td>
                    <td>{a.email}</td>
                    <td>
                      {a.memberships.map((m) => `${teamName(m.teamId)} (${m.role})`).join(', ')}
                    </td>
                    <td>{a.ticketLimit}</td>
                    <td>{a.openCount}</td>
                    <td>{a.languages.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}
      {tab === 'rules' ? (
        <>
          <Card>
            <h2 className="mb-2 font-semibold">Add routing rule</h2>
            <RuleForm directory={dir.data} />
          </Card>
          <Card>
            <ol className="space-y-1 text-sm">
              {rules.data?.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Badge>{r.position}</Badge>
                  {r.recipient !== null ? (
                    <span>
                      to <b>{r.recipient}</b>
                    </span>
                  ) : null}
                  {r.subjectKeywords.length > 0 ? (
                    <span>
                      subject has <b>{r.subjectKeywords.join(', ')}</b>
                    </span>
                  ) : null}
                  {r.language !== null ? (
                    <span>
                      language <b>{r.language}</b>
                    </span>
                  ) : null}
                  <span>
                    → <b>{teamName(r.teamId)}</b>
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void unwrap(
                        api.DELETE('/api/v1/admin/routing-rules/{id}', {
                          params: { path: { id: r.id } },
                        }),
                      ).then(() => client.invalidateQueries({ queryKey: ['admin', 'rules'] }))
                    }
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ol>
          </Card>
        </>
      ) : null}
      {tab === 'mailboxes' ? (
        <>
          <Card>
            <h2 className="mb-2 font-semibold">Add support address</h2>
            <MailboxForm directory={dir.data} />
          </Card>
          <Card>
            <ul className="text-sm">
              {boxes.data?.map((m) => (
                <li key={m.address}>
                  <b>{m.address}</b> → {teamName(m.defaultTeamId)}
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
      {tab === 'jobs' ? (
        <Card>
          <h2 className="mb-2 font-semibold">Background jobs that gave up after all retries</h2>
          {jobs.data?.length === 0 ? (
            <p className="text-sm text-[var(--muted)]" data-testid="no-failed-jobs">
              No failed jobs.
            </p>
          ) : null}
          <ul className="space-y-2 text-sm" data-testid="failed-jobs">
            {jobs.data?.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="red">{j.kind}</Badge>
                <span>
                  {j.attempts}/{j.maxAttempts} attempts
                </span>
                <span className="text-[var(--muted)]">{j.lastError}</span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void unwrap(
                      api.POST('/api/v1/admin/jobs/{id}/retry', { params: { path: { id: j.id } } }),
                    ).then(() => client.invalidateQueries({ queryKey: ['admin', 'jobs'] }))
                  }
                >
                  Retry
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
