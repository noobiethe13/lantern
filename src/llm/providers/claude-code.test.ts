import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LlmError } from '../provider';
import { ClaudeCodeProvider } from './claude-code';

// Compiles fixtures/fake-claude-cli.ts to a standalone executable and puts it
// on PATH as "claude" for the duration of this file, so ClaudeCodeProvider's
// Bun.spawn(['claude', ...]) resolves to it instead of any real CLI. Building
// a real executable (rather than a shim script) is what makes this reliable
// on Windows, where Bun.spawn resolves a bare command via PATH + PATHEXT the
// same way the OS does for any other program.
let fakeBinDir: string;
let originalPath: string | undefined;

beforeAll(async () => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'lantern-fake-claude-'));
  const fakeExe = join(fakeBinDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  const src = join(import.meta.dir, 'fixtures', 'fake-claude-cli.ts');
  const build = Bun.spawnSync(['bun', 'build', '--compile', src, '--outfile', fakeExe]);
  if (build.exitCode !== 0) {
    throw new Error(`failed to build fake claude CLI fixture: ${new TextDecoder().decode(build.stderr)}`);
  }

  originalPath = process.env.PATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = `${fakeBinDir}${sep}${originalPath ?? ''}`;

  // Refuse to run any test below if "claude" doesn't resolve to our fake exe —
  // never let this suite silently fall through to a real CLI subprocess.
  // Bun.which() (like Bun.spawn()) resolves a bare command against a PATH
  // snapshot from Bun's own startup unless the live PATH is passed explicitly.
  const resolved = Bun.which('claude', { PATH: process.env.PATH ?? '' });
  if (!resolved || !resolved.startsWith(fakeBinDir)) {
    throw new Error(`'claude' did not resolve to the fake CLI fixture (got: ${resolved})`);
  }
}, 30_000);

afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_OUT;
  rmSync(fakeBinDir, { recursive: true, force: true });
});

let outFile: string;
beforeEach(() => {
  outFile = join(fakeBinDir, `out-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.FAKE_OUT = outFile;
});

function readRecords(): Array<{ argv: string[]; stdinLen: number }> {
  if (!existsSync(outFile)) return [];
  return readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const OkShape = z.object({ ok: z.boolean() });

describe('ClaudeCodeProvider timeout (P6)', () => {
  test('a timed-out call throws once, without a STRICT_SUFFIX retry', async () => {
    process.env.FAKE_MODE = 'sleep';
    const provider = new ClaudeCodeProvider();

    let caught: unknown;
    try {
      await provider.call({ task: 'verdict', prompt: 'hi', timeoutMs: 300 }, OkShape);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).kind).toBe('transient');
    expect((caught as LlmError).message).toContain('timed out');
    // Exactly one spawn — the bug this guards against retried the whole call
    // (a second spawn) after a timeout, doubling the cost of an already-stuck
    // call for no benefit.
    expect(readRecords()).toHaveLength(1);
  }, 15_000);
});

describe('ClaudeCodeProvider healthcheck (P9)', () => {
  test('without deep, only checks --version — no model call', async () => {
    process.env.FAKE_MODE = 'ok';
    const provider = new ClaudeCodeProvider();

    const result = await provider.healthcheck();

    expect(result.ok).toBe(true);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.argv).toContain('--version');
  });

  test('with deep, also runs the model probe', async () => {
    process.env.FAKE_MODE = 'ok';
    const provider = new ClaudeCodeProvider();

    const result = await provider.healthcheck({ deep: true });

    expect(result.ok).toBe(true);
    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.argv).toContain('--version');
    expect(records[1]!.argv).toContain('--json-schema');
  });
});
