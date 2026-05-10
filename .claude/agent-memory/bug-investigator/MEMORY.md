# Bug-investigator memory — lantern

Recurring debugging surfaces and the patterns that solved them. Read this at the start of Phase 2 (hypothesis formation) before forming initial guesses.

---

## Gemini CLI subprocess (`src/llm/gemini.ts`) — first-call symptom triage

When the L2 pass or any `callGemini`/`callGeminiValidated` consumer fails on the **very first** job, the cause is almost always one of these CLI-integration gotchas, not a logic bug. Walk this list before instrumenting prompts or schemas.

| Exit/Error | Cause | Fix |
|---|---|---|
| `exit 143` + stderr mentions "Ripgrep is not available" or `[LocalAgentExecutor] Blocked call: 'replace'/'write_file'/'run_shell_command'` | CLI registered built-in tools by default in headless mode; model loops on missing approvals until SIGTERM | Spawn with `cwd` = sandbox dir containing `.gemini/settings.json` with `coreTools: []` AND `tools.core: []` (legacy + nested forms — schema rename in flight across CLI versions) |
| `exit 55` "Gemini CLI is not running in a trusted directory" | Recent CLI versions added trust gating | Add `--skip-trust` flag. Do NOT use `GEMINI_CLI_TRUST_WORKSPACE=true` via `env:` on Windows — it breaks `.cmd` shim resolution in `Bun.spawn`. |
| `ENOENT: no such file or directory, uv_spawn 'gemini'` (Windows) | Explicit `env:` option to `Bun.spawn` broke PATHEXT-based shim lookup | Drop the `env:` option entirely; use `--skip-trust` flag instead of the env var |
| Zod error: every field `undefined` | Wrapper shape changed. `--output-format json` now emits `{response: "<string>", stats}`, not `{response: {text}}` | Handle all three legacy shapes when extracting `innerText` |
| `JSON Parse error: Unexpected identifier "Please"` / "I" / etc. | 2.5-pro wrapped JSON in conversational prose despite "Return ONLY JSON" | Extract first balanced `{...}` before parse; retry on parse failures (not just schema failures) with strict-suffix prompt |
| Model replies "Please provide me with the job description…" | **Windows-only.** Multi-line `--prompt <string>` truncated at first newline — model only saw the first line | Pipe prompt through stdin (`stdin: 'pipe'`, `proc.stdin.write(prompt); await proc.stdin.end()`). Drop `--prompt` from args. |

**Sequencing matters when diagnosing.** These bugs nest: tool-loop hides trust gate hides wrapper-shape hides arg-truncation. Each fix uncovers the next symptom. Don't assume the first error is the only one.

**False trail noted (2026-05-10):** "first job fails → auth expiry" was not the cause here — `gemini auth status` was healthy throughout. Auth issues typically surface as exit 1 with a token-related stderr, not the patterns above.

---
