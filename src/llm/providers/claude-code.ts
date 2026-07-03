import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { extractFirstJsonBlock, stripCodeFence } from '../extract-json';
import { classifyErrorMessage, LlmError } from '../provider';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';
import { zodToProviderSchema } from '../zod-to-schema';

type ClaudeModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5';

const TASK_MODELS: Record<LlmTask, ClaudeModel> = {
  verdict: 'claude-sonnet-4-6',
  // nl-filter drives the entire search — getting the criteria wrong wastes the
  // whole scan — so it runs on sonnet despite being a single short call.
  'nl-filter': 'claude-sonnet-4-6',
};

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Respond with ONLY the JSON object that conforms to the provided schema. No prose, no markdown, no code fences.';

// Replaces Claude Code's heavy agentic default system prompt. The task prompt
// already carries full instructions and `--json-schema` constrains the output,
// so a minimal generic system prompt is enough — and roughly halves per-call
// token cost versus the default.
const ISOLATED_SYSTEM_PROMPT =
  'You convert the user message into a single JSON object that conforms to the provided JSON schema. Output only that JSON object — no prose, no markdown, no code fences.';

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

// Run claude from a throwaway directory so no project-level CLAUDE.md is
// auto-discovered into the context. Created once per process.
let isolatedCwdMemo: string | null = null;
function isolatedCwd(): string {
  if (!isolatedCwdMemo) isolatedCwdMemo = mkdtempSync(join(tmpdir(), 'lantern-claude-'));
  return isolatedCwdMemo;
}

// Walk the wrapper Claude Code emits and return the raw structured payload.
// `--json-schema` is supposed to populate `structured_output`, but versions
// vary: some emit `{ result: "<json-as-string>" }`, others embed the JSON in
// prose inside `result`. Try each shape in order.
function unwrapClaudeResponse(stdout: string): unknown {
  let wrapper: Record<string, unknown>;
  try {
    wrapper = JSON.parse(stdout);
  } catch (err) {
    const preview = stdout.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      `claude response was not parseable JSON (preview: "${preview}"): ${(err as Error).message}`,
    );
  }

  if ('structured_output' in wrapper && wrapper.structured_output !== undefined) {
    return wrapper.structured_output;
  }

  // `result` is sometimes a JSON-as-string, sometimes prose with JSON inside.
  if (typeof wrapper.result === 'string') {
    const cleaned = stripCodeFence(wrapper.result);
    try {
      return JSON.parse(cleaned);
    } catch {
      const block = extractFirstJsonBlock(cleaned);
      if (block) {
        try { return JSON.parse(block); } catch { /* fall through */ }
      }
    }
  }

  return wrapper;
}

async function spawnClaude<T>(
  model: ClaudeModel,
  prompt: string,
  schema: z.ZodType<T>,
  timeoutMs?: number,
): Promise<unknown> {
  const jsonSchema = JSON.stringify(zodToProviderSchema(schema));

  // We deliberately do NOT use `--bare`: it disables OAuth/keychain auth and
  // forces ANTHROPIC_API_KEY, so subscription users get "Not logged in". We
  // instead keep normal auth and isolate the context flag-by-flag:
  //   -p                       print mode (one-shot, non-interactive).
  //   --output-format json     structured wrapper around the model output.
  //   --json-schema            constrains the response to the supplied schema
  //                            (populates `structured_output`).
  //   --system-prompt          replaces the agentic default (cheaper, focused).
  //   --setting-sources ''     load no user/project/local settings → no hooks.
  //   --strict-mcp-config +    use only the empty inline MCP config → no MCP
  //   --mcp-config             servers.
  //   --disable-slash-commands no skills.
  //   cwd = throwaway dir      no project CLAUDE.md auto-discovery.
  // Prompt piped on stdin to avoid Windows multi-line argv truncation
  // (a known gotcha with headless CLI wrappers).
  const proc = Bun.spawn(
    [
      'claude', '-p', '--model', model,
      '--output-format', 'json', '--json-schema', jsonSchema,
      '--system-prompt', ISOLATED_SYSTEM_PROMPT,
      '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
      '--disable-slash-commands',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: isolatedCwd() },
  );

  const timeout = setTimeout(() => proc.kill('SIGTERM'), timeoutMs ?? 120_000);

  proc.stdin.write(prompt);
  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    // Auth/usage failures (e.g. "Not logged in · Please run /login") arrive on
    // stdout inside the JSON wrapper's `result`, with stderr empty. Surface
    // that so classifyErrorMessage can flag fatal cases instead of retrying.
    throw new Error(`claude cli exit ${exitCode}: ${stderr.trim() || resultMessage(stdout)}`);
  }

  return unwrapClaudeResponse(stdout);
}

// Best-effort extraction of the human-readable message the CLI puts in the
// wrapper's `result` field on error. Falls back to a stdout preview.
function resultMessage(stdout: string): string {
  try {
    const wrapper = JSON.parse(stdout) as { result?: unknown };
    if (typeof wrapper.result === 'string' && wrapper.result.trim()) return wrapper.result.trim();
  } catch {
    /* not JSON — fall through */
  }
  return stdout.slice(0, 200).replace(/\s+/g, ' ').trim() || '(no output)';
}

export class ClaudeCodeProvider implements LlmProvider {
  readonly name = 'claude-code' as const;

  defaultModelFor(task: LlmTask): string {
    return TASK_MODELS[task];
  }

  async call<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
    const model = (req.modelOverride ?? this.defaultModelFor(req.task)) as ClaudeModel;

    try {
      const raw = await spawnClaude(model, req.prompt, schema, req.timeoutMs);
      const first = schema.safeParse(raw);
      if (first.success) return first.data;
      console.warn(`[claude-code] first-attempt schema error: ${first.error.message}`);
    } catch (err) {
      const msg = (err as Error).message;
      console.warn(`[claude-code] first-attempt failed: ${msg}`);
      if (classifyErrorMessage(msg) === 'fatal') {
        throw new LlmError('fatal', `claude-code: ${msg}`);
      }
    }

    try {
      const strict = await spawnClaude(model, req.prompt + STRICT_SUFFIX, schema, req.timeoutMs);
      return schema.parse(strict);
    } catch (err) {
      const msg = (err as Error).message;
      throw new LlmError(classifyErrorMessage(msg), `claude-code: ${msg}`);
    }
  }

  async healthcheck(): Promise<HealthcheckResult> {
    let version: string;
    try {
      const proc = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode !== 0) {
        return {
          ok: false,
          detail: `claude --version exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).trim()}`,
        };
      }
      version = new TextDecoder().decode(proc.stdout).trim();
    } catch (err) {
      return {
        ok: false,
        detail: `claude CLI not found — install Claude Code from https://claude.com/claude-code (${(err as Error).message})`,
      };
    }

    // Real probe: a tiny structured call. `--version` only proves the binary
    // exists; it does NOT prove auth works (the old --bare/--help probe falsely
    // reported healthy while the user was logged out). A trivial haiku call
    // surfaces "Not logged in" and wrapper breakage before the first scan.
    const ProbeShape = z.object({ ok: z.boolean() });
    try {
      const raw = await spawnClaude('claude-haiku-4-5', 'Respond with the JSON {"ok":true}.', ProbeShape, 30_000);
      ProbeShape.parse(raw);
      return { ok: true, detail: version };
    } catch (err) {
      return { ok: false, detail: `${version} — call failed: ${(err as Error).message}` };
    }
  }
}
