import { describe, expect, test } from 'bun:test';
import { extractFirstJsonBlock, stripCodeFence } from './extract-json';

describe('extractFirstJsonBlock', () => {
  test('returns null when no bracket present', () => {
    expect(extractFirstJsonBlock('no json here at all')).toBeNull();
    expect(extractFirstJsonBlock('')).toBeNull();
  });

  test('extracts a simple object', () => {
    expect(extractFirstJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  test('extracts a simple array', () => {
    expect(extractFirstJsonBlock('[1, 2, 3]')).toBe('[1, 2, 3]');
  });

  test('skips leading prose', () => {
    const s = 'Here is the response: {"verdict":"yes"}';
    expect(extractFirstJsonBlock(s)).toBe('{"verdict":"yes"}');
  });

  test('handles nested objects', () => {
    const s = '{"outer":{"inner":{"deep":true}}}';
    expect(extractFirstJsonBlock(s)).toBe(s);
  });

  test('handles nested arrays', () => {
    const s = '[[1,2],[3,4]]';
    expect(extractFirstJsonBlock(s)).toBe(s);
  });

  test('ignores brackets inside strings', () => {
    const s = '{"key":"value with } brace"}';
    expect(extractFirstJsonBlock(s)).toBe(s);
  });

  test('handles escaped quotes inside strings', () => {
    const s = '{"key":"he said \\"hi}\\" then left"}';
    expect(extractFirstJsonBlock(s)).toBe(s);
  });

  test('returns first balanced block, ignoring trailing prose', () => {
    const s = '{"a":1} and then some more text';
    expect(extractFirstJsonBlock(s)).toBe('{"a":1}');
  });

  test('returns null on unbalanced input', () => {
    expect(extractFirstJsonBlock('{"a":1')).toBeNull();
    expect(extractFirstJsonBlock('[1,2,3')).toBeNull();
  });

  test('picks the first opener — object before array', () => {
    expect(extractFirstJsonBlock('{"a":1} [2,3]')).toBe('{"a":1}');
  });

  test('picks the first opener — array before object', () => {
    expect(extractFirstJsonBlock('[1,2,3] {"a":1}')).toBe('[1,2,3]');
  });
});

describe('stripCodeFence', () => {
  test('passes through unfenced content', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });

  test('strips ```json fence', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('strips plain ``` fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('is case-insensitive on the language tag', () => {
    expect(stripCodeFence('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('trims surrounding whitespace', () => {
    expect(stripCodeFence('   {"a":1}   ')).toBe('{"a":1}');
  });
});
