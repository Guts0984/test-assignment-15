'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SurveyForm } from '@/features/portal-forms';
import { customerApi, isApiCallError, unwrap, type SurveyView } from '@/shared/api';
import { messageForCode } from '@/shared/lib';
import { ErrorNote, Spinner } from '@/shared/ui';

export function SurveyPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(
    () => setToken(/[#&]token=([A-Za-z0-9_-]{20,})/.exec(window.location.hash)?.[1] ?? null),
    [],
  );
  const q = useQuery({
    queryKey: ['survey', token],
    enabled: typeof token === 'string',
    retry: false,
    queryFn: () =>
      unwrap<SurveyView>(customerApi('X-Survey-Token', token as string).GET('/api/v1/survey')),
  });
  return (
    <div className="mx-auto max-w-lg p-4" data-testid="survey">
      <h1 className="mb-3 text-xl font-semibold">Rate the answer</h1>
      {token === undefined ? (
        <Spinner />
      ) : token === null ? (
        <ErrorNote>This page needs the link from your email.</ErrorNote>
      ) : q.isPending ? (
        <Spinner />
      ) : q.isError || q.data === undefined ? (
        <ErrorNote>
          {messageForCode(
            isApiCallError(q.error) ? q.error.code : 'LINK_INVALID',
            'This survey cannot be opened.',
          )}
        </ErrorNote>
      ) : (
        <>
          <p className="mb-3 text-sm">
            Request #{q.data.ticketNumber}: {q.data.subject}
          </p>
          <SurveyForm token={token} survey={q.data} onSaved={() => void q.refetch()} />
        </>
      )}
    </div>
  );
}
