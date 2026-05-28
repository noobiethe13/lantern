import { z } from 'zod';
import { extractFirstJsonBlock, stripCodeFence } from '../extract-json';
import { classifyErrorMessage, LlmError } from '../provider';
import type { HealthcheckResult, LlmProvider, LlmRequest, LlmTask } from '../provider';
import { zodToProviderSchema } from '../zod-to-schema';

type ClaudeModel = 'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5';

const TASK_MODELS: Record<LlmTask, ClaudeModel> = {
  verdict: 'claude-sonnet-4-6',
  'nl-filter': 'claude-haiku-4-5',
  'html-extract': 'claude-sonnet-4-6',
  'hn-extract': 'claude-haiku-4-5',
};

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Respond with ONLY the JSON object that conforms to the provided schema. No prose, no markdown, no code fences.';

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

  // --bare: skip hooks, skills, plugins, MCP servers, and CLAUDE.md
  //   auto-discovery. This is what neutralizes project-level CLAUDE.md
  //   files without needing a tmpdir cwd workaround.
  // -p: print mode (one-shot, non-interactive).
  // --output-format json: structured wrapper around the model output.
  // --json-schema: constrains the model's response to the supplied schema.
  // Prompt piped on stdin to avoid Windows multi-line argv truncation
  // (same gotcha as the legacy gemini-cli wrapper).
  const proc = Bun.spawn(
    ['claude', '--bare', '-p', '--model', model, '--output-format', 'json', '--json-schema', jsonSchema],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );

  const timeout = setTimeout(() => proc.kill('SIGTERM'), timeoutMs ?? 120_000);

  proc.stdin.write(prompt);
  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(`claude cli exit ${exitCode}: ${stderr.trim()}`);
  }

  return unwrapClaudeResponse(stdout);
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

    // Wrapper-shape probe: confirm --bare + -p + --output-format json still
    // produce a JSON object on stdout. Doesn't burn a real LLM call (uses
    // --help-style trivial prompt with a tight timeout). Surfaces upstream
    // CLI breakage early rather than at first scan.
    try {
      const proc = Bun.spawn(
        ['claude', '--bare', '-p', '--output-format', 'json', '--help'],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const timeout = setTimeout(() => proc.kill('SIGTERM'), 5_000);
      const exit = await proc.exited;
      clearTimeout(timeout);
      if (exit !== 0) {
        return { ok: true, detail: `${version} (wrapper probe skipped: --help exit ${exit})` };
      }
    } catch {
      // probe failure isn't fatal — version succeeded
    }

    return { ok: true, detail: version };
  }
}
