import { describe, expect, test } from 'bun:test';
import { splitCommand } from './local-parser';

describe('splitCommand', () => {
  test('splits a plain command', () => {
    expect(splitCommand('node parser.js')).toEqual(['node', 'parser.js']);
  });

  test('respects double-quoted argv', () => {
    expect(splitCommand('node "my parser.js" arg')).toEqual(['node', 'my parser.js', 'arg']);
  });

  test('handles escaped quotes inside quoted strings', () => {
    expect(splitCommand('cmd "he said \\"hi\\"" tail')).toEqual(['cmd', 'he said "hi"', 'tail']);
  });

  test('collapses runs of whitespace', () => {
    expect(splitCommand('a   b\tc')).toEqual(['a', 'b', 'c']);
  });

  test('returns empty for blank input', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
  });

  test('handles a trailing unterminated quote by absorbing the rest', () => {
    expect(splitCommand('cmd "abc')).toEqual(['cmd', 'abc']);
  });
});
