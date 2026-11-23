'use client';
import type { Directory } from '@/shared/api';
import type { ReportFilters } from '@/shared/lib';
import { Field, TextInput } from '@/shared/ui';

const selectClass =
  'w-full rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-sm';

/** Controlled filters; the page keeps them in the URL, so reload and Back restore them. */
export function ReportFiltersForm({
  value,
  onChange,
  directory,
}: {
  value: ReportFilters;
  onChange: (v: ReportFilters) => void;
  directory: Directory | undefined;
}) {
  const agents = (directory?.agents ?? []).filter(
    (a) => a.role === 'agent' && (value.teamId === '' || a.teamId === value.teamId),
  );
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label="Report filters"
      onSubmit={(e) => e.preventDefault()}
    >
      <Field label="From" htmlFor="rf-from">
        <TextInput
          id="rf-from"
          type="date"
          value={value.from}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </Field>
      <Field label="To" htmlFor="rf-to">
        <TextInput
          id="rf-to"
          type="date"
          value={value.to}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </Field>
      <Field label="Team" htmlFor="rf-team">
        <select
          id="rf-team"
          className={selectClass}
          value={value.teamId}
          onChange={(e) => onChange({ ...value, teamId: e.target.value, agentId: '' })}
        >
          <option value="">All my teams</option>
          {(directory?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Agent" htmlFor="rf-agent">
        <select
          id="rf-agent"
          className={selectClass}
          value={value.agentId}
          onChange={(e) => onChange({ ...value, agentId: e.target.value })}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Priority" htmlFor="rf-priority">
        <select
          id="rf-priority"
          className={selectClass}
          value={value.priority}
          onChange={(e) => onChange({ ...value, priority: e.target.value })}
        >
          <option value="">Any</option>
          {['urgent', 'high', 'normal', 'low'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
    </form>
  );
}
