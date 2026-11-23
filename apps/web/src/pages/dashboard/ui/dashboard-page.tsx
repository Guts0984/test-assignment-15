'use client';
import { PageTitle } from '@/shared/ui';
import { AppShell } from '@/widgets/app-shell';
import { LeadDashboard } from '@/widgets/lead-dashboard';

export function DashboardPage() {
  return (
    <AppShell>
      <PageTitle>Team dashboard</PageTitle>
      <LeadDashboard />
    </AppShell>
  );
}
