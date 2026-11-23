'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PortalReplyForm } from '@/features/portal-forms';
import { customerApi, isApiCallError, tokenStore, unwrap, type PortalTicket } from '@/shared/api';
import { messageForCode } from '@/shared/lib';
import { connectRealtime } from '@/shared/socket';
import { Badge, Card, ErrorNote, Spinner } from '@/shared/ui';

const readToken = (): string | null => {
  const fromHash = /[#&]token=([A-Za-z0-9_-]{20,})/.exec(window.location.hash)?.[1];
  try {
    if (fromHash !== undefined) {
      window.sessionStorage.setItem('helpdesk:portal-token', fromHash);
      return fromHash;
    }
    return window.sessionStorage.getItem('helpdesk:portal-token');
  } catch {
    return fromHash ?? null;
  }
};

const download = async (id: string, name: string, token: string): Promise<void> => {
  const r = await fetch(`/api/v1/portal/attachments/${id}`, {
    headers: { 'X-Ticket-Token': token },
  });
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

/** The conversation behind the link in the email: no password; the link names exactly one ticket. */
export function PortalView() {
  const client = useQueryClient();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setToken(readToken()), []);
  useEffect(() => {
    if (typeof token !== 'string') return;
    tokenStore.set(null);
    const conn = connectRealtime(() => ({ ticketToken: token }));
    const refresh = (): void => void client.invalidateQueries({ queryKey: ['portal'] });
    conn.socket.on('message.created', refresh);
    conn.socket.on('ticket.updated', refresh);
    return () => conn.close();
  }, [token, client]);
  const q = useQuery({
    queryKey: ['portal', token],
    enabled: typeof token === 'string',
    retry: false,
    queryFn: () =>
      unwrap<PortalTicket>(
        customerApi('X-Ticket-Token', token as string).GET('/api/v1/portal/ticket'),
      ),
  });
  if (token === undefined) return <Spinner />;
  if (token === null) return <ErrorNote>This page needs the link from your email.</ErrorNote>;
  if (q.isPending) return <Spinner />;
  if (q.isError || q.data === undefined) {
    const code = isApiCallError(q.error) ? q.error.code : 'LINK_INVALID';
    return (
      <div className="space-y-3">
        <ErrorNote>{messageForCode(code, 'We could not open this conversation.')}</ErrorNote>
        <p className="text-sm">
          Need help?{' '}
          <Link className="underline" href="/new-request">
            Contact support
          </Link>
          .
        </p>
      </div>
    );
  }
  const t = q.data;
  return (
    <div className="mx-auto max-w-2xl space-y-3" data-testid="portal">
      <h1 className="text-xl font-semibold" data-testid="portal-subject">
        #{t.number} {t.subject} <Badge>{t.status.replace('_', ' ')}</Badge>
      </h1>
      {notice !== null ? (
        <p
          role="status"
          className="rounded-md bg-green-600/15 p-2 text-sm"
          data-testid="portal-notice"
        >
          {notice}
        </p>
      ) : null}
      <div className="space-y-2">
        {t.messages.map((m) => (
          <Card
            key={m.id}
            className={
              m.direction === 'outbound' ? 'border-[var(--reply-line)] bg-[var(--reply-bg)]' : ''
            }
          >
            <p className="mb-1 text-xs text-[var(--muted)]">
              <b>{m.direction === 'outbound' ? (m.authorName ?? 'Support') : 'You'}</b> ·{' '}
              {new Date(m.createdAt).toLocaleString()}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm" data-testid="portal-message">
              {m.body}
            </p>
            {m.attachments.map((a) => (
              <button
                key={a.id}
                className="mt-1 mr-2 text-xs underline"
                onClick={() => void download(a.id, a.filename, token)}
              >
                📎 {a.filename}
              </button>
            ))}
          </Card>
        ))}
      </div>
      <Card>
        <h2 className="mb-2 font-semibold">
          {t.status === 'closed' ? 'This request is closed — replying opens a new one' : 'Reply'}
        </h2>
        <PortalReplyForm
          token={token}
          onSent={(r) => {
            setNotice(
              r.newRequest
                ? `We opened a new request #${r.number} for you. We emailed you a link to follow it.`
                : 'Your reply was sent.',
            );
            void client.invalidateQueries({ queryKey: ['portal'] });
          }}
        />
      </Card>
    </div>
  );
}
