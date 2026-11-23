'use client';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TicketList } from '@/entities/ticket';
import { SearchBox } from '@/features/search-tickets';
import { api, unwrap, type SearchResults } from '@/shared/api';
import { ErrorNote, PageTitle, Spinner } from '@/shared/ui';
import { AppShell } from '@/widgets/app-shell';

export function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/search';
  const q = (params?.get('q') ?? '').trim();
  const result = useQuery({
    queryKey: ['search', q],
    enabled: q !== '',
    queryFn: () =>
      unwrap<SearchResults>(api.GET('/api/v1/search', { params: { query: { q, limit: 50 } } })),
  });
  return (
    <AppShell>
      <PageTitle>Search</PageTitle>
      <div className="mb-4">
        <SearchBox
          value={q}
          onCommit={(v) =>
            router.replace(
              v.trim() === '' ? pathname : `${pathname}?q=${encodeURIComponent(v.trim())}`,
            )
          }
        />
      </div>
      {q === '' ? (
        <p className="text-sm text-[var(--muted)]">
          Search by words in the correspondence, a customer name or email, or a ticket number like
          #100123.
        </p>
      ) : result.isPending ? (
        <Spinner />
      ) : result.isError ? (
        <ErrorNote>The search failed. Try different words.</ErrorNote>
      ) : (
        <TicketList
          label="Search results"
          items={result.data.items}
          emptyText={`No tickets match “${q}”.`}
        />
      )}
    </AppShell>
  );
}
