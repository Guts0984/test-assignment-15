'use client';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { email as emailSchema, holidayInput, mailboxInput, teamInput } from '@helpdesk/shared';
import { api, unwrap, type Directory } from '@/shared/api';
import { useApiForm } from '@/shared/lib';
import { Button, ErrorNote, Field, TextInput } from '@/shared/ui';

const selectClass =
  'w-full rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-sm';
const useRefresh = () => {
  const client = useQueryClient();
  return () =>
    client
      .invalidateQueries({ queryKey: ['admin'] })
      .then(() => client.invalidateQueries({ queryKey: ['directory'] }));
};

const agentFormSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Required').max(200),
  password: z.string().refine((v) => v === '' || v.length >= 8, 'At least 8 characters'),
  ticketLimit: z.number({ invalid_type_error: 'Enter a number' }).int().min(0).max(500),
  languages: z.array(z.enum(['en', 'uk', 'pl', 'de'])).min(1, 'Choose at least one language'),
  teamId: z.string(),
  role: z.enum(['agent', 'lead']),
});

const ruleFormSchema = z
  .object({
    position: z.number({ invalid_type_error: 'Enter a number' }).int().min(0),
    recipient: z
      .string()
      .refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter an email address'),
    keywords: z.string(),
    language: z.string(),
    teamId: z.string().uuid('Choose a team'),
  })
  .refine((v) => v.recipient !== '' || v.keywords.trim() !== '' || v.language !== '', {
    path: ['recipient'],
    message: 'Set at least one condition',
  });

type TeamValues = {
  name: string;
  defaultLanguage: 'en' | 'uk' | 'pl' | 'de';
  timeZone: string;
  workdays: number[];
  workStart: string;
  workEnd: string;
};

export function TeamForm() {
  const refresh = useRefresh();
  const { form, onSubmit, formError } = useApiForm<TeamValues>(
    teamInput,
    {
      name: '',
      defaultLanguage: 'en',
      timeZone: 'Europe/Kyiv',
      workdays: [1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
    },
    async (v) => {
      await unwrap(api.POST('/api/v1/admin/teams', { body: v }));
      form.reset();
      await refresh();
    },
    ['name', 'timeZone', 'workStart', 'workEnd', 'workdays', 'defaultLanguage'],
  );
  const e = form.formState.errors;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Create team"
      className="grid gap-x-3 sm:grid-cols-3"
    >
      {formError !== null ? (
        <div className="sm:col-span-3">
          <ErrorNote>{formError}</ErrorNote>
        </div>
      ) : null}
      <Field label="Team name" htmlFor="team-name" error={e.name?.message}>
        <TextInput id="team-name" invalid={e.name !== undefined} {...form.register('name')} />
      </Field>
      <Field label="Time zone (IANA)" htmlFor="team-tz" error={e.timeZone?.message}>
        <TextInput id="team-tz" invalid={e.timeZone !== undefined} {...form.register('timeZone')} />
      </Field>
      <Field label="Default language" htmlFor="team-lang">
        <select id="team-lang" className={selectClass} {...form.register('defaultLanguage')}>
          {['en', 'uk', 'pl', 'de'].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="Work starts" htmlFor="team-start" error={e.workStart?.message}>
        <TextInput
          id="team-start"
          invalid={e.workStart !== undefined}
          {...form.register('workStart')}
        />
      </Field>
      <Field label="Work ends" htmlFor="team-end" error={e.workEnd?.message}>
        <TextInput id="team-end" invalid={e.workEnd !== undefined} {...form.register('workEnd')} />
      </Field>
      <div className="flex items-end pb-3">
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Create team
        </Button>
      </div>
    </form>
  );
}

export function HolidayForm({ teamId }: { teamId: string }) {
  const refresh = useRefresh();
  const { form, onSubmit, formError } = useApiForm<{ date: string; name: string }>(
    holidayInput,
    { date: '', name: '' },
    async (v) => {
      await unwrap(
        api.POST('/api/v1/admin/teams/{id}/holidays', {
          params: { path: { id: teamId } },
          body: v,
        }),
      );
      form.reset();
      await refresh();
    },
    ['date', 'name'],
  );
  const e = form.formState.errors;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Add holiday"
      className="flex flex-wrap items-start gap-2"
    >
      {formError !== null ? <ErrorNote>{formError}</ErrorNote> : null}
      <Field label="Date" htmlFor={`hd-date-${teamId}`} error={e.date?.message}>
        <TextInput
          id={`hd-date-${teamId}`}
          type="date"
          invalid={e.date !== undefined}
          {...form.register('date')}
        />
      </Field>
      <Field label="Name" htmlFor={`hd-name-${teamId}`} error={e.name?.message}>
        <TextInput
          id={`hd-name-${teamId}`}
          invalid={e.name !== undefined}
          {...form.register('name')}
        />
      </Field>
      <div className="pt-6">
        <Button type="submit" variant="secondary">
          Add holiday
        </Button>
      </div>
    </form>
  );
}

type AgentValues = {
  email: string;
  name: string;
  password: string;
  ticketLimit: number;
  languages: ('en' | 'uk' | 'pl' | 'de')[];
  teamId: string;
  role: 'agent' | 'lead';
  active: boolean;
  memberships: { teamId: string; role: 'agent' | 'lead' }[];
};

export function AgentForm({ directory }: { directory: Directory | undefined }) {
  const refresh = useRefresh();
  const { form, onSubmit, formError } = useApiForm<AgentValues>(
    agentFormSchema,
    {
      email: '',
      name: '',
      password: '',
      ticketLimit: 20,
      languages: ['en'],
      teamId: '',
      role: 'agent',
      active: true,
      memberships: [],
    },
    async (v) => {
      const body = {
        email: v.email,
        name: v.name,
        password: v.password === '' ? undefined : v.password,
        ticketLimit: Number(v.ticketLimit),
        languages: v.languages,
        memberships: v.teamId === '' ? [] : [{ teamId: v.teamId, role: v.role }],
        active: true,
      };
      await unwrap(api.POST('/api/v1/admin/agents', { body: body as never }));
      form.reset();
      await refresh();
    },
    ['email', 'name', 'password', 'ticketLimit', 'languages', 'memberships'],
  );
  const e = form.formState.errors;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Add agent"
      className="grid gap-x-3 sm:grid-cols-3"
    >
      {formError !== null ? (
        <div className="sm:col-span-3">
          <ErrorNote>{formError}</ErrorNote>
        </div>
      ) : null}
      <Field label="Email" htmlFor="ag-email" error={e.email?.message}>
        <TextInput
          id="ag-email"
          type="email"
          invalid={e.email !== undefined}
          {...form.register('email')}
        />
      </Field>
      <Field label="Name" htmlFor="ag-name" error={e.name?.message}>
        <TextInput id="ag-name" invalid={e.name !== undefined} {...form.register('name')} />
      </Field>
      <Field label="Password" htmlFor="ag-pass" error={e.password?.message}>
        <TextInput
          id="ag-pass"
          type="password"
          autoComplete="new-password"
          {...form.register('password')}
        />
      </Field>
      <Field label="Concurrent ticket limit" htmlFor="ag-limit" error={e.ticketLimit?.message}>
        <TextInput
          id="ag-limit"
          type="number"
          min={0}
          invalid={e.ticketLimit !== undefined}
          {...form.register('ticketLimit', { valueAsNumber: true })}
        />
      </Field>
      <Field
        label="Languages"
        htmlFor="ag-langs"
        hint="Hold Ctrl to pick several"
        error={e.languages?.message as string | undefined}
      >
        <select id="ag-langs" multiple className={selectClass} {...form.register('languages')}>
          {['en', 'uk', 'pl', 'de'].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="Team" htmlFor="ag-team">
        <select id="ag-team" className={selectClass} {...form.register('teamId')}>
          <option value="">— none —</option>
          {(directory?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Role in team" htmlFor="ag-role">
        <select id="ag-role" className={selectClass} {...form.register('role')}>
          <option value="agent">agent</option>
          <option value="lead">team lead</option>
        </select>
      </Field>
      <div className="flex items-end pb-3">
        <Button type="submit">Add agent</Button>
      </div>
    </form>
  );
}

export function RuleForm({ directory }: { directory: Directory | undefined }) {
  const refresh = useRefresh();
  type V = {
    position: number;
    recipient: string;
    keywords: string;
    language: string;
    teamId: string;
  };
  const { form, onSubmit, formError } = useApiForm<V>(
    ruleFormSchema,
    { position: 100, recipient: '', keywords: '', language: '', teamId: '' },
    async (v) => {
      const body = {
        position: Number(v.position),
        recipient: v.recipient === '' ? null : v.recipient,
        subjectKeywords: v.keywords
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k !== ''),
        language: v.language === '' ? null : v.language,
        teamId: v.teamId,
      };
      await unwrap(api.POST('/api/v1/admin/routing-rules', { body: body as never }));
      form.reset();
      await refresh();
    },
    ['position', 'recipient', 'subjectKeywords', 'language', 'teamId'],
  );
  const e = form.formState.errors as Record<string, { message?: string } | undefined>;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Add routing rule"
      className="grid gap-x-3 sm:grid-cols-3"
    >
      {formError !== null ? (
        <div className="sm:col-span-3">
          <ErrorNote>{formError}</ErrorNote>
        </div>
      ) : null}
      <Field label="Order (lower first)" htmlFor="rl-pos" error={e['position']?.message}>
        <TextInput
          id="rl-pos"
          type="number"
          {...form.register('position', { valueAsNumber: true })}
        />
      </Field>
      <Field label="Sent to address" htmlFor="rl-rcpt" error={e['recipient']?.message}>
        <TextInput
          id="rl-rcpt"
          placeholder="billing@helpdesk.test"
          {...form.register('recipient')}
        />
      </Field>
      <Field
        label="Subject contains (comma separated)"
        htmlFor="rl-kw"
        error={e['subjectKeywords']?.message}
      >
        <TextInput id="rl-kw" placeholder="invoice, refund" {...form.register('keywords')} />
      </Field>
      <Field label="Language" htmlFor="rl-lang">
        <select id="rl-lang" className={selectClass} {...form.register('language')}>
          <option value="">any</option>
          {['en', 'uk', 'pl', 'de'].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="Route to team" htmlFor="rl-team" error={e['teamId']?.message}>
        <select id="rl-team" className={selectClass} {...form.register('teamId')}>
          <option value="">— choose —</option>
          {(directory?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end pb-3">
        <Button type="submit">Add rule</Button>
      </div>
    </form>
  );
}

export function MailboxForm({ directory }: { directory: Directory | undefined }) {
  const refresh = useRefresh();
  const { form, onSubmit, formError } = useApiForm<{ address: string; defaultTeamId: string }>(
    mailboxInput,
    { address: '', defaultTeamId: '' },
    async (v) => {
      await unwrap(api.POST('/api/v1/admin/mailboxes', { body: v }));
      form.reset();
      await refresh();
    },
    ['address', 'defaultTeamId'],
  );
  const e = form.formState.errors;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Add mailbox"
      className="flex flex-wrap items-start gap-3"
    >
      {formError !== null ? <ErrorNote>{formError}</ErrorNote> : null}
      <Field label="Support address" htmlFor="mb-addr" error={e.address?.message}>
        <TextInput id="mb-addr" invalid={e.address !== undefined} {...form.register('address')} />
      </Field>
      <Field label="Default team" htmlFor="mb-team" error={e.defaultTeamId?.message}>
        <select id="mb-team" className={selectClass} {...form.register('defaultTeamId')}>
          <option value="">— choose —</option>
          {(directory?.teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="pt-6">
        <Button type="submit">Add mailbox</Button>
      </div>
    </form>
  );
}
