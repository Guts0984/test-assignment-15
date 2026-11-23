'use client';
import { Suspense } from 'react';
import { PageTitle, Spinner } from '@/shared/ui';
import { AppShell } from '@/widgets/app-shell';
import { ReportView } from '@/widgets/report-view';

export function ReportsPage() {
  return (
    <AppShell>
      <PageTitle>Reports</PageTitle>
      <Suspense fallback={<Spinner />}>
        <ReportView />
      </Suspense>
    </AppShell>
  );
}
