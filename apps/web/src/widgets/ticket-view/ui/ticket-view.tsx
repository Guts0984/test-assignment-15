'use client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isLeadOrAdmin, useSession } from '@/entities/session';
import {
  currentDeadline,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  SlaCountdown,
  STATUS_LABEL,
  STATUS_TONE,
} from '@/entities/ticket';
import { lastPublicSeq, ReplyComposer } from '@/features/reply-composer';
import { TicketActions } from '@/features/ticket-actions';
import {
  api,
  isApiCallError,
  tokenStore,
  unwrap,
  type Directory,
  type StaffMessage,
  type TicketDetail,
} from '@/shared/api';
import { useSocket } from '@/shared/socket';
import { describeEvent, type NameLookup } from '../model/history-text';
import { Badge, Card, ErrorNote, Spinner } from '@/shared/ui';

type Viewer = { userId: string; name: string; state: 'viewing' | 'typing' };
const HEARTBEAT_MS = 10_000;

const download = async (id: string, name: string): Promise<void> => {
  const r = await fetch(`/api/v1/attachments/${id}`, {
    headers: { authorization: `Bearer ${tokenStore.get() ?? ''}` },
  });
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

function Message({ m }: { m: StaffMessage }) {
  const isNote = m.kind === 'note';
  const undone = m.cancelledAt !== null;
  const mine = m.direction === 'outbound';
  return (
    <article
      data-testid="message"
      data-kind={isNote ? 'note' : mine ? 'reply' : 'customer'}
      data-undone={undone}
      className={clsx(
        'rounded-lg border-2 p-3',
        isNote && 'border-dashed border-[var(--note-line)] bg-[var(--note-bg)]',
        !isNote && mine && 'border-solid border-[var(--reply-line)] bg-[var(--reply-bg)]',
        !isNote && !mine && 'border-[var(--line)] bg-[var(--card)]',
        undone && 'opacity-50',
      )}
    >
      <header className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <b>{m.authorName ?? (m.authorKind === 'customer' ? 'Customer' : 'System')}</b>
        {isNote ? (
          <Badge tone="amber">🔒 Internal note</Badge>
        ) : mine ? (
          <Badge tone="blue">Reply to customer</Badge>
        ) : null}
        {m.autoKind !== null ? <Badge>{m.autoKind}</Badge> : null}
        {m.originTicketId !== null ? <Badge>merged</Badge> : null}
        {undone ? <Badge tone="red">undone</Badge> : null}
        {mine && !undone && m.sendState === 'scheduled' ? (
          <Badge tone="amber">sending…</Badge>
        ) : null}
        {mine && m.sendState === 'sent' ? <Badge tone="green">sent</Badge> : null}
        {mine && (m.sendState === 'failed' || m.sendState === 'bounced') ? (
          <Badge tone="red">{m.sendState}</Badge>
        ) : null}
        <time className="ml-auto text-[var(--muted)]" dateTime={m.createdAt}>
          {new Date(m.createdAt).toLocaleString()}
        </time>
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
      {m.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-xs">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <button className="underline" onClick={() => void download(a.id, a.filename)}>
                📎 {a.filename} ({Math.ceil(a.size / 1024)} KB)
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** Whole ticket: thread, history, who else is here, actions and the composer, live through the socket. */
export function TicketView({ ticketId }: { ticketId: string }) {
  const session = useSession();
  const { socket, connected } = useSocket();
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const lastSeq = useRef(0);
  const query = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () =>
      unwrap<TicketDetail>(api.GET('/api/v1/tickets/{id}', { params: { path: { id: ticketId } } })),
    retry: false,
  });
  const directory = useQuery({
    queryKey: ['directory'],
    queryFn: () => unwrap<Directory>(api.GET('/api/v1/directory')),
    staleTime: 60_000,
  });
  const detail = query.data;
  const names = useMemo<NameLookup>(() => {
    const users = new Map((directory.data?.agents ?? []).map((a) => [a.id, a.name]));
    const teams = new Map((directory.data?.teams ?? []).map((t) => [t.id, t.name]));
    return { user: (id) => users.get(id) ?? null, team: (id) => teams.get(id) ?? null };
  }, [directory.data]);
  const seen = useMemo(() => (detail === undefined ? 0 : lastPublicSeq(detail.messages)), [detail]);
  useEffect(() => {
    lastSeq.current = Math.max(lastSeq.current, detail?.ticket.messageSeq ?? 0);
  }, [detail]);

  // Join the ticket room (re-done after every reconnect) and keep our presence alive.
  useEffect(() => {
    if (socket === null || !connected) return;
    const onPresence = (p: { ticketId: string; viewers: Viewer[] }): void => {
      if (p.ticketId === ticketId) setViewers(p.viewers);
    };
    socket.on('presence:changed', onPresence);
    const subscribe = (): void => {
      socket.emit(
        'ticket:subscribe',
        { ticketId, lastSeq: lastSeq.current },
        (r: { ok: boolean; viewers?: Viewer[] }) => r.ok && setViewers(r.viewers ?? []),
      );
    };
    subscribe();
    const beat = setInterval(
      () => socket.emit('presence:update', { ticketId, state: 'viewing' }, () => undefined),
      HEARTBEAT_MS,
    );
    return () => {
      clearInterval(beat);
      socket.off('presence:changed', onPresence);
      socket.emit('ticket:unsubscribe', { ticketId }, () => undefined);
    };
  }, [socket, connected, ticketId]);

  const others = viewers.filter((v) => v.userId !== session.user?.id);
  if (query.isPending)
    return (
      <div className="p-8 text-center">
        <Spinner />
      </div>
    );
  if (query.isError || detail === undefined) {
    return (
      <ErrorNote>
        {isApiCallError(query.error) && query.error.status === 404
          ? 'This ticket does not exist or you have no access to it.'
          : 'Could not load the ticket.'}
      </ErrorNote>
    );
  }
  const t = detail.ticket;
  const deadline = currentDeadline(t);
  return (
    <div
      className="grid gap-4 lg:grid-cols-[1fr_320px]"
      data-testid="ticket-view"
      data-ticket-id={t.id}
    >
      <div className="space-y-3">
        <header>
          <h1 className="text-xl font-semibold" data-testid="ticket-subject">
            #{t.number} {t.subject}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{STATUS_LABEL[t.status]}</Badge>
            <Badge tone={PRIORITY_TONE[t.priority] ?? 'gray'}>{PRIORITY_LABEL[t.priority]}</Badge>
            <SlaCountdown dueAt={deadline?.at ?? null} label={deadline?.label ?? undefined} />
            {t.mergedIntoNumber !== null ? <span>Merged into #{t.mergedIntoNumber}</span> : null}
            {t.followUpOfNumber !== null ? <span>Follow-up of #{t.followUpOfNumber}</span> : null}
          </p>
          <div
            aria-live="polite"
            data-testid="presence"
            className="mt-2 flex flex-wrap gap-2 text-xs"
          >
            {others.length === 0 ? (
              <span className="text-[var(--muted)]">Only you are here.</span>
            ) : (
              others.map((v) => (
                <span
                  key={v.userId}
                  data-testid="presence-viewer"
                  data-state={v.state}
                  className="rounded-full bg-black/10 px-2 py-0.5"
                >
                  {v.name} {v.state === 'typing' ? 'is typing…' : 'is viewing'}
                </span>
              ))
            )}
          </div>
        </header>
        <div className="space-y-2" data-testid="thread">
          {detail.messages.map((m) => (
            <Message key={m.id} m={m} />
          ))}
        </div>
        <ReplyComposer
          ticketId={t.id}
          lastSeenSeq={seen}
          disabled={t.status === 'closed'}
          onTyping={(typing) =>
            socket?.emit(
              'presence:update',
              { ticketId: t.id, state: typing ? 'typing' : 'viewing' },
              () => undefined,
            )
          }
        />
      </div>
      <aside className="space-y-3">
        <Card>
          <h2 className="mb-2 font-semibold">Customer</h2>
          <p className="text-sm">
            {t.customerName}
            <br />
            {t.customerEmail}
          </p>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Owner: {t.assigneeName ?? 'unassigned'} · Created{' '}
            {new Date(t.createdAt).toLocaleString()}
          </p>
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">Actions</h2>
          <TicketActions
            ticket={t}
            directory={directory.data}
            meId={session.user?.id ?? ''}
            canClose={isLeadOrAdmin(session.user)}
          />
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">History</h2>
          <ol className="space-y-1 text-xs" data-testid="history">
            {detail.events.map((e) => (
              <li key={e.id}>
                <time className="text-[var(--muted)]">
                  {new Date(e.createdAt).toLocaleString()}
                </time>{' '}
                — <b>{e.actorName ?? e.actorKind}</b>{' '}
                <span className="text-[var(--muted)]">{describeEvent(e, names)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </aside>
    </div>
  );
}
