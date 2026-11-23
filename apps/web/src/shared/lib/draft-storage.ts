/** Reply and note drafts survive reloads: stored per ticket and kind, never throws when storage is unavailable. */
export type DraftKind = 'reply' | 'note';
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (ticketId: string, kind: DraftKind): string =>
  `helpdesk:draft:${ticketId}:${kind}`;

export const loadDraft = (
  storage: StorageLike | null,
  ticketId: string,
  kind: DraftKind,
): string => {
  try {
    return storage?.getItem(draftKey(ticketId, kind)) ?? '';
  } catch {
    return '';
  }
};

export const saveDraft = (
  storage: StorageLike | null,
  ticketId: string,
  kind: DraftKind,
  text: string,
): void => {
  try {
    if (text === '') storage?.removeItem(draftKey(ticketId, kind));
    else storage?.setItem(draftKey(ticketId, kind), text);
  } catch {
    /* storage full or blocked: the draft is simply not persisted */
  }
};

export const clearDraft = (storage: StorageLike | null, ticketId: string, kind: DraftKind): void =>
  saveDraft(storage, ticketId, kind, '');

export const browserStorage = (): StorageLike | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};
