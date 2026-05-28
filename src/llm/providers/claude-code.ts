import { z } from 'zod';
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

async function spawnClaude<T>(
  model: ClaudeModel,
  prompt: string,
  schema: z.ZodType<T>,
  timeoutMs?: number,
): Promise<unknown> {
  const jsonSchema = JSON.stringify(zodToProviderSchema(schema));

  // --bare: skip hooks, skills, plugins, MCP servers, and CLAUDE.md auto-discovery.
  // -p: print mode (one-shot, non-interactive).
  // --output-format json: structured wrapper around the model output.
  // --json-schema: constrains the model's response to the supplied schema.
  // Prompt piped on stdin to avoid Windows multi-line argv truncation
  // (same gotcha as the Gemini CLI wrapper).
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

  // Claude Code returns { structured_output: <object>, ...metadata }.
  // Fall back to parsing the whole stdout as JSON if the wrapper shape ever changes.
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
  // Defensive: some versions emit `{ result: "<json-as-string>" }` when
  // --json-schema isn't honored; try to parse that string.
  if (typeof wrapper.result === 'string') {
    try { return JSON.parse(wrapper.result); } catch { /* fall through */ }
  }
  return wrapper;
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
    } catch {
      // fall through to strict retry
    }

    const strict = await spawnClaude(model, req.prompt + STRICT_SUFFIX, schema, req.timeoutMs);
    return schema.parse(strict);
  }

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const proc = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode === 0) {
        return { ok: true, detail: new TextDecoder().decode(proc.stdout).trim() };
      }
      return {
        ok: false,
        detail: `claude --version exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr).trim()}`,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `claude CLI not found — install Claude Code from https://claude.com/claude-code (${(err as Error).message})`,
      };
    }
  }
}
