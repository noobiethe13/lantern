// A stand-in for the real `claude` CLI, compiled to a standalone executable at
// test time (see claude-code.test.ts) and put on PATH so ClaudeCodeProvider's
// `Bun.spawn(['claude', ...])` resolves to this instead of a real subprocess.
// Never invoked outside tests.
//
// Every invocation appends one JSON line to FAKE_OUT (argv + stdin length) so
// tests can assert exactly how many times — and with what — the CLI was
// spawned. Behavior is selected via FAKE_MODE:
//   ok    - a normal successful structured_output response.
//   sleep - hangs for 10 minutes (simulates a stuck call for timeout tests).
import { appendFileSync } from 'node:fs';

const stdin = await Bun.stdin.text();

const out = process.env.FAKE_OUT;
if (out) {
  appendFileSync(out, JSON.stringify({ argv: process.argv.slice(2), stdinLen: stdin.length }) + '\n');
}

const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'ok') {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { ok: true } }));
} else if (mode === 'sleep') {
  await Bun.sleep(600_000);
}
