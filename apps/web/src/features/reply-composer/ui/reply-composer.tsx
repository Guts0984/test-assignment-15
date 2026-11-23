'use client';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, isApiCallError, unwrap } from '@/shared/api';
import {
  browserStorage,
  clearDraft,
  clockStore,
  loadDraft,
  messageForCode,
  saveDraft,
  type DraftKind,
} from '@/shared/lib';
import { clientEnv } from '@/shared/config/env.client';
import { Button, ErrorNote, TextArea } from '@/shared/ui';
import { parseConflict, undoSecondsLeft, type ConflictMessage } from '../model/composer-model';

type Props = {
  ticketId: string;
  lastSeenSeq: number;
  disabled: boolean;
  onTyping: (typing: boolean) => void;
};

type Undo = { messageId: string; sendAfter: string; text: string };

export function ReplyComposer({ ticketId, lastSeenSeq, disabled, onTyping }: Props) {
  const client = useQueryClient();
  const [kind, setKind] = useState<DraftKind>('reply');
  const [drafts, setDrafts] = useState<Record<DraftKind, string>>({ reply: '', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    messages: ConflictMessage[];
    latestSeq: number;
  } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const skew = useSyncExternalStore(clockStore.subscribe, clockStore.getSkew, clockStore.getSkew);
  const undoButton = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The draft is restored from storage after a reload, per ticket and per kind.
  useEffect(() => {
    const s = browserStorage();
    setDrafts({ reply: loadDraft(s, ticketId, 'reply'), note: loadDraft(s, ticketId, 'note') });
  }, [ticketId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const secondsLeft = undo === null ? 0 : undoSecondsLeft(undo.sendAfter, now + skew);
  useEffect(() => {
    if (undo !== null && secondsLeft === 0) setUndo(null);
  }, [undo, secondsLeft]);
  useEffect(() => {
    if (undo !== null) undoButton.current?.focus();
  }, [undo]);

  const update = (text: string): void => {
    setDrafts((d) => ({ ...d, [kind]: text }));
    saveDraft(browserStorage(), ticketId, kind, text);
    onTyping(text !== '');
  };

  const send = async (confirm: boolean): Promise<void> => {
    const text = drafts[kind].trim();
    if (text === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'note') {
        await unwrap(
          api.POST('/api/v1/tickets/{id}/notes', {
            params: { path: { id: ticketId } },
            body: { body: text },
          }),
        );
      } else {
        const r = await unwrap<{ messageId: string; sendAfter: string; serverTime: string }>(
          api.POST('/api/v1/tickets/{id}/replies', {
            params: { path: { id: ticketId } },
            body: {
              body: text,
              lastSeenSeq: conflict?.latestSeq ?? lastSeenSeq,
              confirmNewMessages: confirm,
            },
          }),
        );
        setUndo({ messageId: r.messageId, sendAfter: r.sendAfter, text });
      }
      clearDraft(browserStorage(), ticketId, kind);
      setDrafts((d) => ({ ...d, [kind]: '' }));
      setConflict(null);
      onTyping(false);
      await client.invalidateQueries({ queryKey: ['ticket', ticketId] });
    } catch (e) {
      if (isApiCallError(e) && e.code === 'TICKET_HAS_NEW_MESSAGES') {
        const body = e.body as { error: { data?: unknown } };
        setConflict(parseConflict(body.error.data));
        await client.invalidateQueries({ queryKey: ['ticket', ticketId] });
      } else
        setError(
          isApiCallError(e) ? messageForCode(e.code, e.message) : 'Cannot reach the server.',
        );
    } finally {
      setBusy(false);
    }
  };

  const undoSend = async (): Promise<void> => {
    if (undo === null) return;
    try {
      await unwrap(
        api.DELETE('/api/v1/tickets/{id}/replies/{messageId}', {
          params: { path: { id: ticketId, messageId: undo.messageId } },
        }),
      );
      const restored = undo.text;
      setDrafts((d) => ({ ...d, reply: restored }));
      saveDraft(browserStorage(), ticketId, 'reply', restored);
      setKind('reply');
      setUndo(null);
      await client.invalidateQueries({ queryKey: ['ticket', ticketId] });
      textRef.current?.focus();
    } catch (e) {
      setUndo(null);
      setError(isApiCallError(e) ? messageForCode(e.code, e.message) : 'Cannot reach the server.');
    }
  };

  if (disabled)
    return (
      <p className="text-sm text-[var(--muted)]">
        This ticket is closed. A customer reply opens a new request.
      </p>
    );
  const isNote = kind === 'note';
  return (
    <div data-testid="composer" data-kind={kind} className="space-y-2">
      <div role="tablist" aria-label="Reply type" className="flex gap-2">
        {(['reply', 'note'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            data-testid={`tab-${k}`}
            onClick={() => setKind(k)}
            className={clsx(
              'rounded-t-md border px-3 py-1 text-sm font-medium',
              kind === k
                ? k === 'reply'
                  ? 'border-[var(--reply-line)] bg-[var(--reply-bg)]'
                  : 'border-dashed border-[var(--note-line)] bg-[var(--note-bg)]'
                : 'border-[var(--line)] opacity-70',
            )}
          >
            {k === 'reply' ? 'Reply to customer' : '🔒 Internal note'}
          </button>
        ))}
      </div>
      <div
        className={clsx(
          'rounded-md border-2 p-3',
          isNote
            ? 'border-dashed border-[var(--note-line)] bg-[var(--note-bg)]'
            : 'border-solid border-[var(--reply-line)] bg-[var(--reply-bg)]',
        )}
      >
        <p className="mb-2 text-xs font-semibold" data-testid="composer-hint">
          {isNote
            ? 'Internal note — visible to staff only, never sent to the customer.'
            : 'Public reply — the customer receives this by email.'}
        </p>
        {conflict !== null ? (
          <div
            role="alertdialog"
            aria-label="New messages"
            data-testid="conflict"
            className="mb-2 rounded-md border border-amber-600 bg-amber-500/15 p-2 text-sm"
          >
            <p className="font-medium">
              The ticket has new messages. Review them, then decide whether to send.
            </p>
            <ul className="my-2 list-disc pl-5">
              {conflict.messages.map((m) => (
                <li key={m.id}>
                  <b>{m.authorKind}:</b> {m.body}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button onClick={() => void send(true)} data-testid="send-anyway">
                Send anyway
              </Button>
              <Button variant="secondary" onClick={() => setConflict(null)}>
                Keep editing
              </Button>
            </div>
          </div>
        ) : null}
        {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
        <TextArea
          ref={textRef}
          id="composer-text"
          aria-label={isNote ? 'Internal note' : 'Reply to customer'}
          rows={6}
          value={drafts[kind]}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              void send(false);
            }
          }}
          onBlur={() => onTyping(false)}
          placeholder={isNote ? 'Write a note for colleagues…' : 'Write your reply…'}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button
            onClick={() => void send(false)}
            disabled={busy || drafts[kind].trim() === '' || conflict !== null}
            data-testid="send"
          >
            {isNote ? 'Add note' : 'Send reply'}
          </Button>
          <span className="text-xs text-[var(--muted)]">Ctrl+Enter to send</span>
        </div>
      </div>
      {undo !== null ? (
        <div
          role="status"
          data-testid="undo-bar"
          className="flex items-center gap-3 rounded-md border border-[var(--line)] bg-[var(--card)] p-2 text-sm"
        >
          <span>
            Reply will be sent in <b data-testid="undo-seconds">{secondsLeft}</b> s
          </span>
          <Button
            ref={undoButton}
            variant="secondary"
            onClick={() => void undoSend()}
            data-testid="undo-send"
          >
            Undo
          </Button>
          <span className="text-xs text-[var(--muted)]">
            of {clientEnv.NEXT_PUBLIC_UNDO_SEND_SECONDS} s
          </span>
        </div>
      ) : null}
    </div>
  );
}
