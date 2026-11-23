'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { clockStore, formatRemaining, remainingMs, urgencyOf } from '@/shared/lib';

/** A live countdown computed from the SERVER clock (skew from X-Server-Time), never from the browser clock alone. */
export function SlaCountdown({
  dueAt,
  label,
  totalMs = null,
}: {
  dueAt: string | null;
  label?: string;
  totalMs?: number | null;
}) {
  const skew = useSyncExternalStore(clockStore.subscribe, clockStore.getSkew, clockStore.getSkew);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (dueAt === null) return <span className="text-xs text-[var(--muted)]">no deadline</span>;
  if (now === null) return <span className="text-xs">…</span>;
  const left = remainingMs(dueAt, now, skew);
  const urgency = urgencyOf(left, totalMs);
  return (
    <span
      data-testid="sla-countdown"
      data-urgency={urgency}
      data-remaining-ms={left}
      className={clsx(
        'whitespace-nowrap text-xs font-medium tabular-nums',
        urgency === 'overdue' && 'text-red-600',
        urgency === 'critical' && 'text-orange-600',
        urgency === 'warning' && 'text-amber-600',
      )}
    >
      {label !== undefined ? `${label}: ` : ''}
      {formatRemaining(left)}
    </span>
  );
}
