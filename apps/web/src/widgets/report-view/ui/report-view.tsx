'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { ReportFiltersForm } from '@/features/report-filters';
import { api, unwrap, type Directory, type Report } from '@/shared/api';
import { parseFilters, serializeFilters, type ReportFilters } from '@/shared/lib';
import { Card, ErrorNote, Spinner } from '@/shared/ui';

const min = (v: number | null): string =>
  v === null ? '–' : v < 90 ? `${v.toFixed(0)} min` : `${(v / 60).toFixed(1)} h`;

type Row = Report['total'] & { name: string };
function Table({ rows, caption, testId }: { rows: Row[]; caption: string; testId: string }) {
  return (
    <Card>
      <table className="w-full text-left text-sm" data-testid={testId}>
        <caption className="mb-2 text-left font-semibold">{caption}</caption>
        <thead>
          <tr className="text-xs text-[var(--muted)]">
            <th>Name</th>
            <th>Tickets</th>
            <th>First response median</th>
            <th>p90</th>
            <th>Resolution median</th>
            <th>p90</th>
            <th>In SLA</th>
            <th>Breaches</th>
            <th>Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t border-[var(--line)]">
              <th scope="row" className="font-medium">
                {r.name}
              </th>
              <td>{r.tickets}</td>
              <td>{min(r.firstResponseMedianMinutes)}</td>
              <td>{min(r.firstResponseP90Minutes)}</td>
              <td>{min(r.resolutionMedianMinutes)}</td>
              <td>{min(r.resolutionP90Minutes)}</td>
              <td>{r.withinSlaPercent === null ? '–' : `${r.withinSlaPercent}%`}</td>
              <td>{r.breaches}</td>
              <td>{r.ratingAverage === null ? '–' : `${r.ratingAverage} (${r.ratingCount})`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Report for a period. Filters are the URL: change them and the address changes, reload and Back restore them. */
export function ReportView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/reports';
  const today = useMemo(() => new Date(), []);
  const filters = parseFilters(new URLSearchParams(params?.toString() ?? ''), today);
  const set = (f: ReportFilters): void => router.push(`${pathname}?${serializeFilters(f)}`);
  const dir = useQuery({
    queryKey: ['directory'],
    queryFn: () => unwrap<Directory>(api.GET('/api/v1/directory')),
    staleTime: 60_000,
  });
  const report = useQuery({
    queryKey: ['report', filters],
    queryFn: () =>
      unwrap<Report>(
        api.GET('/api/v1/reports', {
          params: {
            query: {
              from: filters.from,
              to: filters.to,
              ...(filters.teamId !== '' ? { teamId: filters.teamId } : {}),
              ...(filters.agentId !== '' ? { agentId: filters.agentId } : {}),
              ...(filters.priority !== '' ? { priority: filters.priority as 'high' } : {}),
            },
          },
        }),
      ),
  });
  const r = report.data;
  return (
    <div className="space-y-4" data-testid="report-view">
      <Card>
        <ReportFiltersForm value={filters} onChange={set} directory={dir.data} />
      </Card>
      {report.isPending ? (
        <Spinner />
      ) : report.isError || r === undefined ? (
        <ErrorNote>The report could not be loaded for these filters.</ErrorNote>
      ) : (
        <>
          <Table
            testId="report-total"
            caption="Total"
            rows={[{ name: 'All tickets', ...r.total }]}
          />
          <Table
            testId="report-teams"
            caption="By team"
            rows={r.byTeam.map((x) => ({ ...x, name: x.teamName }))}
          />
          <Table
            testId="report-agents"
            caption="By agent"
            rows={r.byAgent.map((x) => ({ ...x, name: x.agentName }))}
          />
          <Card>
            <h2 className="mb-2 font-semibold">Customer ratings</h2>
            <ul className="flex gap-4 text-sm" data-testid="report-ratings">
              {[1, 2, 3, 4, 5].map((n) => (
                <li key={n}>
                  {n}★ <b>{r.ratingDistribution.find((d) => d.rating === n)?.count ?? 0}</b>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
