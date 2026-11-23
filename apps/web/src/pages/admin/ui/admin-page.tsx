'use client';
import { isAdmin, useSession } from '@/entities/session';
import { ErrorNote, PageTitle } from '@/shared/ui';
import { AdminPanels } from '@/widgets/admin-panels';
import { AppShell } from '@/widgets/app-shell';

export function AdminPage() {
  const { user } = useSession();
  return (
    <AppShell>
      <PageTitle>Administration</PageTitle>
      {isAdmin(user) ? (
        <AdminPanels />
      ) : (
        <ErrorNote>Only administrators can open this page.</ErrorNote>
      )}
    </AppShell>
  );
}
