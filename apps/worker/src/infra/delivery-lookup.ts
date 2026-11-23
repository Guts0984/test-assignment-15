import type { DeliveryLookup } from '@helpdesk/core';

/**
 * Asks the mail delivery system (here the mail stub's HTTP API, in production a provider's message-status API)
 * whether an email with this Message-ID already reached the recipient. Any failure means "cannot tell".
 */
export const createDeliveryLookup =
  (baseUrl: string, fetchImpl: typeof fetch = fetch): DeliveryLookup =>
  async (m) => {
    const url = new URL('/api/messages', baseUrl);
    url.searchParams.set('messageId', `<${m.rfcMessageId}>`);
    url.searchParams.set('to', m.toEmail);
    url.searchParams.set('limit', '1');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return Array.isArray(body) ? body.length > 0 : null;
  };
