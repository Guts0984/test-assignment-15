import { describe, expect, it } from 'vitest';
import { isListKey, isTypingTarget, moveSelection } from './keyboard';

describe('list keyboard navigation', () => {
  it('moves within bounds with arrows and j/k', () => {
    let s = { index: 0, count: 3 };
    s = moveSelection(s, 'ArrowDown');
    s = moveSelection(s, 'j');
    s = moveSelection(s, 'ArrowDown');
    expect(s.index).toBe(2);
    s = moveSelection(s, 'k');
    expect(s.index).toBe(1);
    expect(moveSelection({ index: 0, count: 3 }, 'ArrowUp').index).toBe(0);
  });
  it('jumps to the ends and survives an empty list', () => {
    expect(moveSelection({ index: 1, count: 5 }, 'End').index).toBe(4);
    expect(moveSelection({ index: 3, count: 5 }, 'Home').index).toBe(0);
    expect(moveSelection({ index: 4, count: 0 }, 'ArrowDown').index).toBe(0);
  });
  it('recognizes list keys and typing targets', () => {
    expect(isListKey('j')).toBe(true);
    expect(isListKey('x')).toBe(false);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
