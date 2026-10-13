import { useState, useEffect } from 'react';
import { Check, XCircle } from 'lucide-react';
import type { ScanEvent } from '@/lib/sse';

// An l2_done event whose pass was aborted (fatal provider error) or that logged
// grading errors is real trouble, not a plain success — don't draw it green.
export function isL2Trouble(event: ScanEvent): boolean {
  if (event.type !== 'l2_done') return false;
  const d = event.data;
  return Boolean(d?.aborted) || (typeof d?.errors === 'number' && d.errors > 0);
}

export function formatSpan(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// The scan's stages, derived from its event stream. The bus doesn't replay, so
// a page that reconnects mid-run (`resumed`) never saw the early counts — it
// shows what it has without pretending to know a fraction.
type Phase = 'interpreting' | 'fetching' | 'ranking' | 'scoring' | 'done';
const PHASES: Phase[] = ['interpreting', 'fetching', 'ranking', 'scoring', 'done'];

export interface Pipeline {
  phase: Phase;
  failed: boolean;
  resumed: boolean;
  boardsTotal: number;
  boardsDone: number;
  boardErrors: number;
  jobsFound: number;
  l1Pass: number | null;
  rescued: number | null;
  l2Total: number | null;
  l2Done: number;
}

export function freshPipeline(resumed = false): Pipeline {
  return {
    phase: resumed ? 'fetching' : 'interpreting', failed: false, resumed,
    boardsTotal: 0, boardsDone: 0, boardErrors: 0, jobsFound: 0,
    l1Pass: null, rescued: null, l2Total: null, l2Done: 0,
  };
}

export function advance(p: Pipeline, e: ScanEvent): Pipeline {
  const d = e.data ?? {};
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  const atLeast = (ph: Phase): Phase => (PHASES.indexOf(p.phase) < PHASES.indexOf(ph) ? ph : p.phase);
  switch (e.type) {
    case 'start': return { ...p, phase: atLeast('fetching'), boardsTotal: num('sourcesTotal') || p.boardsTotal };
    // the cache pass reports all its boards in one event
    case 'source_done': return { ...p, phase: atLeast('fetching'), boardsDone: p.boardsDone + (num('cachedBoards') || 1), jobsFound: p.jobsFound + num('count') };
    case 'source_error': return { ...p, phase: atLeast('fetching'), boardsDone: p.boardsDone + 1, boardErrors: p.boardErrors + 1 };
    case 'source_warning': return { ...p, boardsDone: p.boardsDone + num('rateLimited') };
    case 'scan_done': return { ...p, phase: atLeast('ranking'), boardsDone: Math.max(p.boardsDone, p.boardsTotal), jobsFound: num('jobsFound'), l1Pass: num('jobsL1Pass') };
    case 'rescue_start': return { ...p, phase: atLeast('ranking') };
    case 'rescue_done': return { ...p, rescued: num('promoted') };
    case 'l2_start': return { ...p, phase: atLeast('scoring'), l2Total: num('total') };
    case 'l2_progress': return { ...p, phase: atLeast('scoring'), l2Done: p.l2Done + 1 };
    case 'l2_done': case 'done': return { ...p, phase: 'done', failed: isL2Trouble(e) && Boolean(d.aborted) };
    case 'error': return { ...p, failed: true };
    default: return p;
  }
}

const n = (v: number) => v.toLocaleString();

function stageMeta(stage: Phase, p: Pipeline, state: 'done' | 'active' | 'pending'): { meta: string; frac: number | null; warn?: string } {
  switch (stage) {
    case 'interpreting':
      return { meta: state === 'done' ? 'Understood' : state === 'active' ? 'Claude is reading it' : '', frac: null };
    case 'fetching': {
      if (state === 'pending') return { meta: '', frac: null };
      const known = p.boardsTotal > 0 && !p.resumed;
      const boards = known ? `${n(Math.min(p.boardsDone, p.boardsTotal))} of ${n(p.boardsTotal)} boards · ` : '';
      return {
        meta: `${boards}${n(p.jobsFound)} jobs`,
        frac: known ? Math.min(1, p.boardsDone / p.boardsTotal) : null,
        warn: p.boardErrors > 0 ? `${n(p.boardErrors)} failed` : undefined,
      };
    }
    case 'ranking':
      if (p.l1Pass == null) return { meta: '', frac: null };
      return { meta: `${n(p.l1Pass)} passed filters${p.rescued ? ` · ${n(p.rescued)} rescued` : ''}`, frac: null };
    case 'scoring':
      if (state === 'pending') return { meta: '', frac: null };
      if (p.l2Total == null) return { meta: `${n(p.l2Done)} scored`, frac: null };
      if (p.l2Total === 0) return { meta: 'Nothing new to score', frac: null };
      return { meta: `${n(Math.min(p.l2Done, p.l2Total))} of ${n(p.l2Total)}`, frac: Math.min(1, p.l2Done / p.l2Total) };
    default:
      return { meta: '', frac: null };
  }
}

const STAGES: { key: Phase; label: string }[] = [
  { key: 'interpreting', label: 'Reading your search' },
  { key: 'fetching', label: 'Searching every board' },
  { key: 'ranking', label: 'Filtering and ranking' },
  { key: 'scoring', label: 'Scoring each match with Claude' },
];

// A vertical run of stages joined by a hairline: done ones check off in amber,
// the live one glows with its own progress, pending ones wait in outline.
// Typographic and quiet; the counts are the content.
export function PipelineView({ p, startedAt }: { p: Pipeline; startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (p.phase === 'done' || p.failed) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [p.phase, p.failed]);
  const cur = PHASES.indexOf(p.phase);
  const elapsed = Math.max(0, now - startedAt);
  return (
    <div className="pipeline" style={{ marginTop: 'var(--space-xl)' }}>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {STAGES.map((s, i) => {
          const state = i < cur ? 'done' : i === cur ? 'active' : 'pending';
          const shown = p.failed && state === 'active' ? 'failed' : state;
          const { meta, frac, warn } = stageMeta(s.key, p, state);
          return (
            <li key={s.key} className="stage" data-state={shown}>
              <span className="stage-glyph" aria-hidden>
                {state === 'done' && <Check size={10} strokeWidth={3} />}
                {shown === 'failed' && <XCircle size={14} />}
              </span>
              <div className="stage-body">
                <div className="stage-line">
                  <span className="stage-label">{s.label}</span>
                  <span className="stage-meta tnum">
                    {meta}
                    {warn && <span style={{ color: 'var(--warning)' }}> · {warn}</span>}
                  </span>
                </div>
                {state === 'active' && !p.failed && (
                  <div className="stage-bar" role="progressbar" aria-label={s.label} aria-valuenow={frac != null ? Math.round(frac * 100) : undefined}>
                    {frac != null
                      ? <div className="stage-fill" style={{ width: `${Math.max(2, frac * 100)}%` }} />
                      : <div className="stage-sweep" />}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {p.phase !== 'done' && !p.failed && (
        <p className="tnum" style={{ margin: '14px 0 0 30px', fontSize: '12px', color: 'var(--text-faint)' }}>
          {formatSpan(elapsed)} elapsed · the search keeps running if you leave this page
        </p>
      )}
      <style>{`
        .stage { position: relative; display: flex; gap: 14px; padding-bottom: 16px; }
        .stage:last-child { padding-bottom: 0; }
        .stage:not(:last-child)::before {
          content: ''; position: absolute; left: 7.5px; top: 20px; bottom: 2px; width: 1px;
          background: var(--border); transition: background 400ms ease;
        }
        .stage[data-state="done"]:not(:last-child)::before { background: color-mix(in oklch, var(--accent) 55%, var(--border)); }
        .stage-glyph {
          position: relative; flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          border: 1.5px solid var(--border); background: var(--bg); color: var(--accent-ink);
          transition: background 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
        }
        .stage[data-state="done"] .stage-glyph { background: var(--accent); border-color: var(--accent); }
        .stage[data-state="active"] .stage-glyph { border-color: var(--accent); box-shadow: 0 0 0 4px color-mix(in oklch, var(--accent) 18%, transparent), 0 0 16px color-mix(in oklch, var(--accent) 60%, transparent); }
        .stage[data-state="active"] .stage-glyph::after {
          content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: glow-pulse 1.4s ease-in-out infinite;
        }
        .stage[data-state="failed"] .stage-glyph { border: none; color: var(--danger); background: none; }
        .stage-body { flex: 1; min-width: 0; }
        .stage-line { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
        .stage-label { font-size: 14px; color: var(--text-faint); transition: color 300ms ease; }
        .stage[data-state="done"] .stage-label { color: var(--text-muted); }
        .stage[data-state="active"] .stage-label { color: var(--text); font-weight: 550; }
        .stage[data-state="failed"] .stage-label { color: var(--danger); }
        .stage-meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stage-bar { position: relative; height: 3px; margin-top: 9px; border-radius: var(--radius-full); background: var(--surface-2); overflow: hidden; }
        .stage-fill {
          position: absolute; inset: 0 auto 0 0; border-radius: var(--radius-full);
          background: linear-gradient(90deg, color-mix(in oklch, var(--accent) 55%, transparent), var(--accent));
          box-shadow: 0 0 10px var(--accent); transition: width 500ms cubic-bezier(0.22,1,0.36,1);
        }
        .stage-sweep {
          position: absolute; top: 0; left: 0; height: 100%; width: 30%; border-radius: var(--radius-full);
          background: linear-gradient(90deg, transparent, var(--accent), transparent);
          animation: sweep 1.3s cubic-bezier(0.45,0,0.55,1) infinite;
        }
      `}</style>
    </div>
  );
}
