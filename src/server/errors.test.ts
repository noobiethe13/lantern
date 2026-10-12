import { test, expect } from 'bun:test';
import { z } from 'zod';
import { zodErrorBody } from './errors';

test('zodErrorBody: error is a readable "path: message" string, not [object Object]', () => {
  const schema = z.object({ display_name: z.string().min(1).max(200) });
  const result = schema.safeParse({ display_name: 'x'.repeat(201) });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('unreachable');
  const body = zodErrorBody(result.error);
  expect(body.error).toBe('display_name: String must contain at most 200 character(s)');
  expect(body.issues).toEqual([{ path: 'display_name', message: 'String must contain at most 200 character(s)' }]);
});

test('zodErrorBody: joins multiple issues and handles root-level (no path) issues', () => {
  const schema = z.object({ a: z.string(), b: z.number() });
  const result = schema.safeParse({ a: 1, b: 'x' });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('unreachable');
  const body = zodErrorBody(result.error);
  expect(body.issues!.length).toBe(2);
  expect(body.error).toContain('a:');
  expect(body.error).toContain('b:');
});
