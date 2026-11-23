/** Realtime events older than what is already shown must never overwrite newer state. */
export const isNewer = (incomingVersion: number, currentVersion: number | undefined): boolean =>
  currentVersion === undefined || incomingVersion > currentVersion;

export type Versioned = { readonly id: string; readonly version: number };

/** Applies a ticket event to a cached list: updates when newer, adds when unknown, never goes backwards. */
export const applyTicketEvent = <T extends Versioned>(
  list: readonly T[],
  incoming: T,
): readonly T[] => {
  const i = list.findIndex((t) => t.id === incoming.id);
  if (i < 0) return [incoming, ...list];
  const current = list[i];
  if (current === undefined || !isNewer(incoming.version, current.version)) return list;
  return list.map((t, j) => (j === i ? incoming : t));
};
