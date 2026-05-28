import { z } from 'zod';
import { JobShape, type Job, type SourceAdapter, type SourceContext } from '../core/job';
import { SourceFetchError } from '../server/errors';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4 MB cap — user-trusted but still bounded

const LocalParserOutputShape = z.array(JobShape);

/**
 * Runs a user-supplied command line and parses its stdout as a JSON array of
 * `Job` objects. The identifier IS the command line — there's no binary
 * allowlist or path-traversal guard, by design: this is a single-machine,
 * single-user local tool and the user trusts the command they configured.
 *
 * Still bounded by:
 *   - configurable timeout (default 60s) via `config_json.timeout_ms`
 *   - 4 MB stdout cap (process killed if exceeded)
 *
 * The command must:
 *   - Exit 0 on success
 *   - Print a JSON array of jobs on stdout matching `JobShape`
 *   - Use stderr for human-readable progress/errors
 */
export class LocalParserAdapter implements SourceAdapter {
  type = 'local-parser' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    const cfg = (ctx.config as { config_json?: { timeout_ms?: number } }).config_json;
    const timeoutMs = cfg?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    const argv = splitCommand(identifier);
    if (argv.length === 0) {
      throw new SourceFetchError('http', `local-parser: empty command for ${display_name}`);
    }

    ctx.emitProgress(`${display_name}: running ${argv[0]}…`);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    } catch (err) {
      throw new SourceFetchError(
        'http',
        `local-parser: failed to spawn '${argv[0]}': ${(err as Error).message}`,
      );
    }

    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    try {
      // Bun.spawn's stdout/stderr are typed as a union — narrow to the
      // ReadableStream branch we requested via stdio: 'pipe'.
      const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
      const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
      const { stdout, truncated } = await readCapped(stdoutStream, MAX_OUTPUT_BYTES, () => proc.kill('SIGTERM'));
      const stderr = await new Response(stderrStream).text();
      const exitCode = await proc.exited;

      if (truncated) {
        throw new SourceFetchError(
          'http',
          `local-parser: '${argv[0]}' exceeded ${MAX_OUTPUT_BYTES} bytes of stdout`,
        );
      }

      if (exitCode !== 0) {
        throw new SourceFetchError(
          'http',
          `local-parser: '${argv[0]}' exited ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
        );
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(stdout);
      } catch (err) {
        const preview = stdout.slice(0, 200).replace(/\s+/g, ' ');
        throw new SourceFetchError(
          'extract',
          `local-parser: stdout was not valid JSON (preview: "${preview}"): ${(err as Error).message}`,
        );
      }

      const validated = LocalParserOutputShape.safeParse(parsedJson);
      if (!validated.success) {
        throw new SourceFetchError(
          'extract',
          `local-parser: output didn't match Job[] schema: ${validated.error.message}`,
        );
      }

      ctx.emitProgress(`${display_name}: ${validated.data.length} jobs`, validated.data.length);
      for (const job of validated.data) {
        yield job;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Naive argv splitter. Honors double-quoted strings and \-escapes inside them.
 * Sufficient for the local-parser case (the user configures the exact command);
 * NOT a full shell parser — no pipes, no env expansion, no globbing.
 */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inQuote = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { buf += ch; escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (buf.length) { out.push(buf); buf = ''; }
      continue;
    }
    buf += ch;
  }
  if (buf.length) out.push(buf);
  return out;
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
): Promise<{ stdout: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        onOverflow();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { stdout: new TextDecoder().decode(merged), truncated };
}
