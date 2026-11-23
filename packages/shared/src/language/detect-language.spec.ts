import { describe, expect, it } from 'vitest';
import { detectLanguage } from './detect-language';

describe('detectLanguage', () => {
  it.each([
    ['Hello, my printer is broken and I need help please', 'en'],
    ['Dzień dobry, nie mam dostępu do konta, proszę o pomoc', 'pl'],
    ['Hallo, ich kann mich nicht anmelden. Bitte helfen Sie mir, danke', 'de'],
    [String.fromCodePoint(0x412, 0x456, 0x442, 0x430, 0x44e, 0x2c, 0x20, 0x44f, 0x20, 0x43d, 0x435, 0x20, 0x43c, 0x43e, 0x436, 0x443), 'uk'],
    ['', 'en'],
    ['12345 !!!', 'en'],
  ])('%s -> %s', (text, lang) => expect(detectLanguage(text)).toBe(lang));

  it('only returns supported languages', () => {
    expect(detectLanguage('Dzień dobry, nie mam dostępu, proszę', ['en', 'de'])).toBe('en');
  });
});
