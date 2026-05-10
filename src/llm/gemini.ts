import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export interface GeminiCallOpts {
  model?: 'gemini-2.5-pro' | 'gemini-2.5-flash';
  prompt: string;
  /** Merged as a prefix into the prompt; the CLI has no separate system instruction flag */
  system?: string;
  timeoutMs?: number;
}

// Gemini CLI registers built-in tools (replace, write_file, run_shell_command,
// GrepTool/Ripgrep, etc.) by default. In non-interactive `--prompt` mode the
// model still tries to invoke them, hangs on missing approval, and gets killed.
// There is no CLI flag to disable tools — the supported lever is settings.json.
// We spawn gemini with cwd pointed at a sandbox dir whose `.gemini/settings.json`
// pins both the legacy (top-level) and current (nested) shapes to an empty
// allowlist, so no built-in tools are registered.
let sandboxCwd: string | null = null;
function ensureSandboxCwd(): string {
  if (sandboxCwd) return sandboxCwd;
  const dir = join(tmpdir(), 'lantern-gemini-sandbox');
  mkdirSync(join(dir, '.gemini'), { recursive: true });
  const settings = {
    coreTools: [],
    excludeTools: ['run_shell_command', 'replace', 'write_file', 'ShellTool', 'GrepTool'],
    tools: {
      core: [],
      exclude: ['run_shell_command', 'replace', 'write_file', 'ShellTool', 'GrepTool'],
    },
  };
  writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify(settings, null, 2));
  sandboxCwd = dir;
  return dir;
}

export async function callGemini(opts: GeminiCallOpts): Promise<unknown> {
  const model = opts.model ?? 'gemini-2.5-flash';
  const fullPrompt = opts.system
    ? `${opts.system}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  // --skip-trust: the CLI refuses to run in an "untrusted" cwd in recent
  // versions; this is the documented headless bypass. The env-var alternative
  // (GEMINI_CLI_TRUST_WORKSPACE=true) breaks Windows .cmd-shim resolution in
  // Bun.spawn when passed via the env option.
  //
  // Prompt via stdin, not --prompt: on Windows, passing a multi-line string
  // as a CLI argument truncates at the first newline, so the model sees only
  // the first line of our prompt and asks for the rest. Piping via stdin
  // bypasses Windows arg parsing entirely.
  const proc = Bun.spawn(
    [
      'gemini',
      '--model', model,
      '--output-format', 'json',
      '--skip-trust',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: ensureSandboxCwd() }
  );

  const timeout = setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs ?? 120_000);

  proc.stdin.write(fullPrompt);
  await proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(`gemini cli exit ${exitCode}: ${stderr.trim()}`);
  }

  // The CLI wraps output. Recent versions emit { response: "<text>", stats: {...} }
  // where `response` is a string. Older shapes used { response: { text: "..." } }
  // or { text: "..." }. Handle all three.
  let innerText: string;
  try {
    const wrapper = JSON.parse(stdout);
    if (typeof wrapper.response === 'string') {
      innerText = wrapper.response;
    } else if (typeof wrapper.response?.text === 'string') {
      innerText = wrapper.response.text;
    } else if (typeof wrapper.text === 'string') {
      innerText = wrapper.text;
    } else {
      innerText = stdout;
    }
  } catch {
    innerText = stdout;
  }

  const cleaned = innerText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  // 2.5-pro sometimes prepends prose despite "Return ONLY JSON" instructions
  // (e.g., "Please find the JSON below: {...}"). Extract the first balanced
  // {...} or [...] block before parsing.
  const extracted = extractFirstJsonBlock(cleaned) ?? cleaned;

  try {
    return JSON.parse(extracted);
  } catch (err) {
    const preview = innerText.slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(
      `gemini response was not parseable JSON (preview: "${preview}"): ${(err as Error).message}`
    );
  }
}

// Find the first balanced JSON object or array in `s`. Naive but sufficient:
// scans for `{` or `[`, walks forward tracking depth, ignoring brackets inside
// strings. Returns the substring or null if no balanced block is found.
function extractFirstJsonBlock(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const STRICT_SUFFIX =
  '\n\nIMPORTANT: Respond with ONLY the JSON object. No prose, no markdown, no code fences. Do not say "Please" or anything else before or after.';

export async function callGeminiValidated<T>(
  opts: GeminiCallOpts,
  schema: z.ZodType<T>
): Promise<T> {
  // Retry on any failure (parse OR schema), not just zod failures — recent
  // 2.5-pro behaviour wraps JSON in prose and trips JSON.parse before zod sees it.
  try {
    const raw = await callGemini(opts);
    const first = schema.safeParse(raw);
    if (first.success) return first.data;
  } catch {
    // fall through to strict retry
  }

  const strict = await callGemini({ ...opts, prompt: opts.prompt + STRICT_SUFFIX });
  return schema.parse(strict);
}
