import { randomUUID } from 'node:crypto';

export type StoredMail = {
  readonly id: string;
  readonly receivedAt: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: readonly string[];
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly messageId: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly attachments: readonly { readonly filename: string; readonly size: number }[];
};

export type Store = {
  readonly add: (m: Omit<StoredMail, 'id' | 'receivedAt'>, at: Date) => StoredMail;
  readonly list: (filter?: {
    to?: string;
    subject?: string;
    limit?: number;
  }) => readonly StoredMail[];
  readonly get: (id: string) => StoredMail | null;
  readonly clear: () => void;
  readonly count: () => number;
};

/** In-memory ring buffer: the stub is a test tool, nothing is persisted. */
export const createStore = (max: number): Store => {
  const items: StoredMail[] = [];
  return {
    add: (m, at) => {
      const stored: StoredMail = { ...m, id: randomUUID(), receivedAt: at.toISOString() };
      items.push(stored);
      if (items.length > max) items.splice(0, items.length - max);
      return stored;
    },
    list: (f = {}) =>
      items
        .filter(
          (m) =>
            (f.to === undefined ||
              m.to.some((t) => t.toLowerCase().includes(f.to?.toLowerCase() ?? ''))) &&
            (f.subject === undefined || m.subject.toLowerCase().includes(f.subject.toLowerCase())),
        )
        .slice(-(f.limit ?? 200))
        .reverse(),
    get: (id) => items.find((m) => m.id === id) ?? null,
    clear: () => {
      items.length = 0;
    },
    count: () => items.length,
  };
};
