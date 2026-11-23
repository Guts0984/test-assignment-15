'use client';
import { useState } from 'react';
import { portalReplyInput, surveyRatingInput } from '@helpdesk/shared';
import { z } from 'zod';
import { apiCallError, customerApi, isApiCallError, unwrap, type SurveyView } from '@/shared/api';
import { toFieldErrors, useApiForm } from '@/shared/lib';
import { Button, ErrorNote, Field, TextArea, TextInput } from '@/shared/ui';

const MAX = 10 * 1024 * 1024;
const sizeOf = (files: FileList | null): number =>
  Array.from(files ?? []).reduce((n, f) => n + f.size, 0);

/** multipart upload helper: browsers set the boundary, so no Content-Type header here. */
const postForm = async (
  url: string,
  fields: Record<string, string>,
  files: FileList | null,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== '') fd.append(k, v);
  for (const f of Array.from(files ?? [])) fd.append('attachments', f);
  const r = await fetch(url, { method: 'POST', body: fd, headers });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw apiCallError(r.status, body);
  return body;
};

type NewRequest = { email: string; name: string; subject: string; body: string };

export function NewRequestForm() {
  const [files, setFiles] = useState<FileList | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const { form, onSubmit, formError } = useApiForm<NewRequest>(
    z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid email'),
      name: z.string().trim().min(1, 'Please tell us your name').max(200),
      subject: z.string().trim().min(1, 'Please add a subject').max(300),
      body: z.string().min(1, 'Please describe the problem').max(100_000),
    }),
    { email: '', name: '', subject: '', body: '' },
    async (v) => {
      if (sizeOf(files) > MAX)
        return void setFileError('Attachments are limited to 10 MB in total.');
      setFileError(null);
      const r = await postForm(
        '/api/v1/public/tickets',
        { ...v, idempotencyKey: `web-${crypto.randomUUID()}` },
        files,
      );
      setDone(Number(r['number']));
    },
    ['email', 'name', 'subject', 'body', 'attachments'],
  );
  const e = form.formState.errors;
  if (done !== null)
    return (
      <div
        role="status"
        data-testid="request-done"
        className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-6"
      >
        <h1 className="text-xl font-semibold">Thank you</h1>
        <p className="mt-2">
          Your request is <b>#{done}</b>. We sent you an email with a link to follow the
          conversation.
        </p>
      </div>
    );
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Contact support"
      className="mx-auto max-w-xl rounded-lg border border-[var(--line)] bg-[var(--card)] p-6"
    >
      <h1 className="mb-4 text-xl font-semibold">Contact support</h1>
      {formError !== null ? <ErrorNote>{formError}</ErrorNote> : null}
      <Field label="Your email" htmlFor="nr-email" error={e.email?.message}>
        <TextInput
          id="nr-email"
          type="email"
          autoComplete="email"
          invalid={e.email !== undefined}
          {...form.register('email')}
        />
      </Field>
      <Field label="Your name" htmlFor="nr-name" error={e.name?.message}>
        <TextInput
          id="nr-name"
          autoComplete="name"
          invalid={e.name !== undefined}
          {...form.register('name')}
        />
      </Field>
      <Field label="Subject" htmlFor="nr-subject" error={e.subject?.message}>
        <TextInput
          id="nr-subject"
          invalid={e.subject !== undefined}
          {...form.register('subject')}
        />
      </Field>
      <Field label="How can we help?" htmlFor="nr-body" error={e.body?.message}>
        <TextArea id="nr-body" rows={6} invalid={e.body !== undefined} {...form.register('body')} />
      </Field>
      <Field
        label="Attachments (up to 10 MB in total)"
        htmlFor="nr-files"
        error={fileError ?? undefined}
      >
        <input id="nr-files" type="file" multiple onChange={(ev) => setFiles(ev.target.files)} />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        Send request
      </Button>
    </form>
  );
}

export function PortalReplyForm({
  token,
  onSent,
}: {
  token: string;
  onSent: (r: { number: number; newRequest: boolean }) => void;
}) {
  const [files, setFiles] = useState<FileList | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const { form, onSubmit, formError } = useApiForm<{ body: string }>(
    z.object({ body: portalReplyInput.shape.body }),
    { body: '' },
    async (v) => {
      if (sizeOf(files) > MAX)
        return void setFileError('Attachments are limited to 10 MB in total.');
      setFileError(null);
      const r = await postForm('/api/v1/portal/replies', v, files, { 'X-Ticket-Token': token });
      form.reset();
      setFiles(null);
      onSent({ number: Number(r['number']), newRequest: r['newRequest'] === true });
    },
    ['body'],
  );
  const e = form.formState.errors;
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void onSubmit();
      }}
      noValidate
      aria-label="Reply"
      className="space-y-2"
    >
      {formError !== null ? <ErrorNote>{formError}</ErrorNote> : null}
      <Field label="Your reply" htmlFor="pr-body" error={e.body?.message}>
        <TextArea id="pr-body" rows={5} invalid={e.body !== undefined} {...form.register('body')} />
      </Field>
      <Field
        label="Attachments (up to 10 MB in total)"
        htmlFor="pr-files"
        error={fileError ?? undefined}
      >
        <input id="pr-files" type="file" multiple onChange={(ev) => setFiles(ev.target.files)} />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        Send reply
      </Button>
    </form>
  );
}

export function SurveyForm({
  token,
  survey,
  onSaved,
}: {
  token: string;
  survey: SurveyView;
  onSaved: (s: SurveyView) => void;
}) {
  const [rating, setRating] = useState<number>(survey.rating ?? 0);
  const [comment, setComment] = useState(survey.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (): Promise<void> => {
    const parsed = surveyRatingInput.safeParse({ rating, ...(comment === '' ? {} : { comment }) });
    if (!parsed.success) return void setError('Please choose a rating from 1 to 5.');
    try {
      const s = await unwrap<SurveyView>(
        customerApi('X-Survey-Token', token).PUT('/api/v1/survey', { body: parsed.data }),
      );
      onSaved(s);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(
        isApiCallError(e)
          ? (toFieldErrors(e.body, []).form ?? e.message)
          : 'Cannot reach the server.',
      );
    }
  };
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        void save();
      }}
      aria-label="Rate the answer"
      className="space-y-3"
    >
      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
      <fieldset>
        <legend className="mb-1 text-sm font-medium">How was our answer?</legend>
        <div className="flex gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className={`cursor-pointer rounded-md border px-3 py-2 ${rating === n ? 'border-brand bg-brand/15' : 'border-[var(--line)]'}`}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                className="sr-only"
                data-testid={`rate-${n}`}
              />
              {n} ★
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Comment (optional)" htmlFor="sv-comment">
        <TextArea
          id="sv-comment"
          rows={4}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </Field>
      <Button type="submit" data-testid="save-rating">
        {survey.rating === null ? 'Send rating' : 'Change rating'}
      </Button>
      {saved ? (
        <p role="status" data-testid="rating-saved">
          Thank you! You can change your rating until{' '}
          {new Date(survey.expiresAt).toLocaleDateString()}.
        </p>
      ) : null}
    </form>
  );
}
