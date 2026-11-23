import type { Language } from '../domain/constants';

const POLISH_LETTERS = /[ąćęłńóśźż]/gi;
const GERMAN_LETTERS = /[äöüß]/gi;
const CYRILLIC_LETTERS = new RegExp('[\u0400-\u04ff]', 'g');

const GERMAN_WORDS = new Set([
  'der',
  'die',
  'das',
  'und',
  'nicht',
  'ich',
  'ist',
  'mit',
  'ein',
  'eine',
  'bitte',
  'danke',
  'hallo',
]);
const POLISH_WORDS = new Set([
  'nie',
  'jest',
  'proszę',
  'dziękuję',
  'czy',
  'dzień',
  'dobry',
  'witam',
  'mam',
  'moje',
]);

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * Cheap language guess for routing: script and diacritics first, then a few stop words.
 * Returns a supported language; anything unclear is English. Only languages in `supported` are returned.
 */
export const detectLanguage = (
  text: string,
  supported: readonly Language[] = ['en', 'uk', 'pl', 'de'],
): Language => {
  const sample = text.slice(0, 2000);
  const letters = Math.max(1, count(sample, /\p{L}/gu));
  const words = sample
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w !== '');
  const candidates: [Language, number][] = [
    ['uk', count(sample, CYRILLIC_LETTERS) / letters > 0.3 ? 10 : 0],
    ['pl', count(sample, POLISH_LETTERS) * 2 + words.filter((w) => POLISH_WORDS.has(w)).length * 3],
    ['de', count(sample, GERMAN_LETTERS) * 2 + words.filter((w) => GERMAN_WORDS.has(w)).length * 3],
  ];
  const best = candidates
    .filter(([l, score]) => score >= 3 && supported.includes(l))
    .sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? 'en';
};
