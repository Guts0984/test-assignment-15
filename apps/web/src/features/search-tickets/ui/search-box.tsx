'use client';
import { useEffect, useState } from 'react';
import { TextInput } from '@/shared/ui';

/** Search box whose value lives in the URL (the page passes `value` and `onCommit`). Debounced, Enter commits at once. */
export function SearchBox({ value, onCommit }: { value: string; onCommit: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const id = setTimeout(() => onCommit(text), 300);
    return () => clearTimeout(id);
  }, [text, value, onCommit]);
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(text);
      }}
    >
      <label htmlFor="search-q" className="sr-only">
        Search tickets
      </label>
      <TextInput
        id="search-q"
        type="search"
        autoFocus
        placeholder="Search correspondence, customer, or ticket number…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="search-input"
      />
    </form>
  );
}
