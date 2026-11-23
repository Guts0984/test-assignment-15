/** Report filters live in the URL so reload and Back restore them. Pure parse/serialize, tolerant of garbage. */
export type ReportFilters = {
  readonly from: string;
  readonly to: string;
  readonly teamId: string;
  readonly agentId: string;
  readonly priority: string;
};

const realDate = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];

export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export const defaultFilters = (today: Date): ReportFilters => ({
  from: isoDay(new Date(today.getTime() - 29 * 86_400_000)),
  to: isoDay(today),
  teamId: '',
  agentId: '',
  priority: '',
});

export const parseFilters = (params: URLSearchParams, today: Date): ReportFilters => {
  const d = defaultFilters(today);
  const pick = (k: string, ok: (v: string) => boolean, fallback: string): string => {
    const v = params.get(k);
    return v !== null && ok(v) ? v : fallback;
  };
  const from = pick('from', realDate, d.from);
  const to = pick('to', realDate, d.to);
  return {
    from: from <= to ? from : d.from,
    to: from <= to ? to : d.to,
    teamId: pick('team', (v) => UUID.test(v), ''),
    agentId: pick('agent', (v) => UUID.test(v), ''),
    priority: pick('priority', (v) => PRIORITIES.includes(v), ''),
  };
};

export const serializeFilters = (f: ReportFilters): string => {
  const p = new URLSearchParams();
  p.set('from', f.from);
  p.set('to', f.to);
  if (f.teamId !== '') p.set('team', f.teamId);
  if (f.agentId !== '') p.set('agent', f.agentId);
  if (f.priority !== '') p.set('priority', f.priority);
  return p.toString();
};
