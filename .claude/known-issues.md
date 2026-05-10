# Quality backlog

Findings from `/quality-audit`. Worked through one at a time via `/remediate`.

State lifecycle: `open` → `in-progress` → `fixed` | `accepted` | `deferred`.
- `accepted`: team has decided not to fix. The auditor will skip on rerun.
- `deferred`: not now, maybe later. The auditor will skip on rerun.
- `fixed`: keep the entry for history; auditor skips.

Add new entries at the bottom; never renumber existing IDs.

---

## KI-001 — generic-url adapter silently returns 0 jobs on gated job boards
- **State**: open
- **Severity**: medium
- **File**: `src/sources/generic-url.ts`
- **Description**: The generic-url adapter accepts any URL but silently produces zero jobs when pointed at LinkedIn, Indeed, Glassdoor, Wellfound, or similar sites. These platforms require authentication or use bot-detection (Cloudflare, login walls). Playwright loads the gate; Gemini receives sparse content and returns `[]`; no error is recorded. The user gets silence instead of a clear failure.
- **Fix direction**: (a) Detect known gated hosts and emit a `source_error` with a "login required" explanation rather than silently yielding nothing. (b) For Wellfound, consider a dedicated adapter using their unofficial API or OAuth flow. LinkedIn/Indeed have no usable public API — best to document them as unsupported.

## KI-002 — SSE stream closes before L2 scoring begins; L2 progress invisible in UI
- **State**: open
- **Severity**: high
- **Files**: `src/runner/scan.ts`, `src/routes/runs.ts`, `ui/src/pages/Run.tsx`
- **Description**: `runScan()` emits `type: 'done'` when source fetching completes. The SSE handler in `runs.ts:59` closes the stream on `done`. `runL2Pass()` then starts and emits `l2_start`/`l2_progress`/`l2_done` to the bus — but the subscriber is already unsubscribed, so nothing reaches the client. The live log goes dark and the UI appears stuck until the backend finishes silently.
- **Fix direction**: Rename `runScan()`'s terminal event to `scan_done` (not `done`). Only close the SSE stream on a new `run_complete` event emitted at the very end of `runFull()` after L2 finishes. Update the client-side `useSSE` handler to match.

## KI-003 — Navigating away from Run page loses live scan state; no reconnect on return
- **State**: open
- **Severity**: medium
- **File**: `ui/src/pages/Run.tsx`
- **Description**: `scanning`, `activeRunId`, and `log` are component-level React state. React Router unmounts `Run.tsx` on navigation; all state resets. On return, `loadRuns()` refetches runs but does not detect that a scan is still in progress (run row has `finished_at = null`) and does not reconnect to the SSE stream. The UI shows "completed" state even though L2 scoring may still be running in the backend.
- **Fix direction**: Lift scan state to a module-level singleton or React context. On `Run.tsx` mount, check `runs[0].finished_at === null` — if so, restore `scanning = true`, set `activeRunId`, and reconnect SSE. Log entries prior to navigation are lost (acceptable); at minimum the connection and status indicator should recover.
