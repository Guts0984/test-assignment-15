'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { sessionStore, useSession } from '@/entities/session';
import { api, unwrap } from '@/shared/api';
import { Button } from '@/shared/ui';

/** "On shift" switch: only agents on shift receive new tickets; going off returns unanswered tickets to the queue. */
export function ShiftToggle() {
  const { user } = useSession();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (user === null) return null;
  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await unwrap<{ onShift: boolean }>(
        api.PUT('/api/v1/me/shift', { body: { onShift: !user.onShift } }),
      );
      sessionStore.set({ status: 'authenticated', user: { ...user, onShift: r.onShift } });
      void client.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant={user.onShift ? 'primary' : 'secondary'}
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={user.onShift}
      data-testid="shift-toggle"
    >
      {user.onShift ? 'On shift' : 'Off shift'}
    </Button>
  );
}
