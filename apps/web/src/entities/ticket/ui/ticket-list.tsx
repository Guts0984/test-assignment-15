'use client';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import {
  currentDeadline,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from '../model/ticket-model';
import { SlaCountdown } from './sla-countdown';
import type { TicketListItem } from '@/shared/api';
import { isListKey, isTypingTarget, moveSelection } from '@/shared/lib';
import { Badge } from '@/shared/ui';

type Props = {
  items: readonly TicketListItem[];
  emptyText: string;
  label: string;
  /** Called for the "t" shortcut on the selected row. */
  onTake?: (t: TicketListItem) => void;
};

/** Ticket rows, fully keyboard-operable: Arrow keys or j/k move, Enter opens, t takes (unassigned lists). */
export function TicketList({ items, emptyText, label, onTake }: Props) {
  const router = useRouter();
  // The selection follows the ticket, not the row position: live updates re-sort the list, and Enter must open the
  // ticket the user is looking at. If that ticket left the list, the selection stays at the same position.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const found = items.findIndex((t) => t.id === selectedId);
  const index = found >= 0 ? found : Math.min(lastIndex.current, Math.max(0, items.length - 1));
  lastIndex.current = index;
  const container = useRef<HTMLUListElement>(null);
  useEffect(() => {
    container.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (isTypingTarget(e.target as HTMLElement)) return;
    if (isListKey(e.key)) {
      e.preventDefault();
      const next = moveSelection({ index, count: items.length }, e.key as never).index;
      setSelectedId(items[next]?.id ?? null);
    } else if (e.key === 'Enter') {
      const t = items[index];
      if (t !== undefined) router.push(`/tickets/${t.id}`);
    } else if (e.key === 't' && onTake !== undefined) {
      const t = items[index];
      if (t !== undefined) onTake(t);
    }
  };

  if (items.length === 0)
    return <p className="py-6 text-center text-sm text-[var(--muted)]">{emptyText}</p>;
  return (
    <ul
      ref={container}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`ticket-row-${items[index]?.id}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)] bg-[var(--card)]"
      data-testid="ticket-list"
    >
      {items.map((t, i) => {
        const deadline = currentDeadline(t);
        return (
          <li
            key={t.id}
            id={`ticket-row-${t.id}`}
            role="option"
            aria-selected={i === index}
            data-index={i}
            data-testid="ticket-row"
            data-ticket-id={t.id}
            data-number={t.number}
            onClick={() => router.push(`/tickets/${t.id}`)}
            onMouseEnter={() => setSelectedId(t.id)}
            className={clsx(
              'flex cursor-pointer items-center gap-3 px-3 py-2',
              i === index && 'bg-brand/10 outline outline-1 -outline-offset-1 outline-brand',
            )}
          >
            <span className="w-16 shrink-0 text-xs text-[var(--muted)]">#{t.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.subject}</span>
              <span className="block truncate text-xs text-[var(--muted)]">
                {t.customerName} · {t.customerEmail}
                {t.assigneeName !== null ? ` · ${t.assigneeName}` : ''}
              </span>
            </span>
            <Badge tone={PRIORITY_TONE[t.priority] ?? 'gray'}>{PRIORITY_LABEL[t.priority]}</Badge>
            <Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{STATUS_LABEL[t.status]}</Badge>
            <span className="w-44 shrink-0 text-right">
              <SlaCountdown dueAt={deadline?.at ?? null} label={deadline?.label ?? undefined} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
