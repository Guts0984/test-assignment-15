/** Keyboard navigation of a list: pure reducer so it is testable without a DOM. */
export type ListState = { readonly index: number; readonly count: number };

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'j' | 'k' | 'Home' | 'End';

export const moveSelection = (s: ListState, key: ListKey): ListState => {
  if (s.count === 0) return { ...s, index: 0 };
  const last = s.count - 1;
  const index =
    key === 'ArrowDown' || key === 'j'
      ? Math.min(last, s.index + 1)
      : key === 'ArrowUp' || key === 'k'
        ? Math.max(0, s.index - 1)
        : key === 'Home'
          ? 0
          : last;
  return { ...s, index };
};

export const isListKey = (k: string): k is ListKey =>
  ['ArrowDown', 'ArrowUp', 'j', 'k', 'Home', 'End'].includes(k);

/** Keys that must never trigger list shortcuts because the user is typing. */
export const isTypingTarget = (
  el: { tagName?: string; isContentEditable?: boolean } | null,
): boolean =>
  el !== null &&
  (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName ?? '') || el.isContentEditable === true);
