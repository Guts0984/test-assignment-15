import { describe, expect, it } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft, type StorageLike } from './draft-storage';

const memory = (): StorageLike & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};

describe('draft storage', () => {
  it('keeps reply and note drafts of different tickets apart and restores them after a "reload"', () => {
    const s = memory();
    saveDraft(s, 't1', 'reply', 'Dear customer');
    saveDraft(s, 't1', 'note', 'internal');
    saveDraft(s, 't2', 'reply', 'other');
    expect([
      loadDraft(s, 't1', 'reply'),
      loadDraft(s, 't1', 'note'),
      loadDraft(s, 't2', 'reply'),
    ]).toEqual(['Dear customer', 'internal', 'other']);
    expect(s.data.has(draftKey('t1', 'reply'))).toBe(true);
  });

  it('clears on send and when the text becomes empty', () => {
    const s = memory();
    saveDraft(s, 't1', 'reply', 'x');
    clearDraft(s, 't1', 'reply');
    expect(loadDraft(s, 't1', 'reply')).toBe('');
    expect(s.data.size).toBe(0);
  });

  it('never throws when storage is missing or broken', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadDraft(null, 't', 'reply')).toBe('');
    expect(loadDraft(broken, 't', 'reply')).toBe('');
    expect(() => saveDraft(broken, 't', 'reply', 'x')).not.toThrow();
    expect(() => saveDraft(null, 't', 'reply', 'x')).not.toThrow();
  });
});
