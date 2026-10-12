import { useState, useEffect, useRef, useCallback, memo, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Circle, CheckCircle2, XCircle, Sparkles, Flag,
  BarChart3, Clock,
} from 'lucide-react';
import { api, formatMoney, type Run, type InterpretedCriteria } from '@/lib/api';
import { useSSE, type ScanEvent } from '@/lib/sse';
import { Button, Spinner, Badge } from '@/components/ui';
import { EmptyLantern, Embers } from '@/components/brand';

// An l2_done event whose pass was aborted (fatal provider error) or that logged
// grading errors is real trouble, not a plain success — don't draw it green.
function isL2Trouble(event: ScanEvent): boolean {
  if (event.type !== 'l2_done') return false;
  const d = event.data;
  return Boolean(d?.aborted) || (typeof d?.errors === 'number' && d.errors > 0);
}

function eventColor(event: ScanEvent): string {
  if (isL2Trouble(event)) return 'var(--danger)';
  switch (event.type) {
    case 'source_done': case 'l2_done': case 'done': return 'var(--success)';
    case 'source_error': case 'error': return 'var(--danger)';
    case 'l2_progress': case 'l2_start': case 'scan_done': return 'var(--accent-text)';
    default: return 'var(--text-faint)';
  }
}

function EventIcon({ event }: { event: ScanEvent }) {
  const p = { size: 13, style: { color: eventColor(event) } };
  if (isL2Trouble(event)) return <XCircle {...p} />;
  switch (event.type) {
    case 'source_done': return <CheckCircle2 {...p} />;
    case 'source_error': case 'error': return <XCircle {...p} />;
    case 'l2_progress': return <Sparkles {...p} />;
    case 'l2_start': case 'l2_done': case 'scan_done': return <BarChart3 {...p} />;
    case 'done': return <Flag {...p} />;
    default: return <Circle {...p} />;
  }
}

// Formatted once when the entry is appended, not on every re-render — a scan
// emits ~1.5-2K events and re-formatting the timestamp on each was O(n^2).
function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface LogEntry { id: number; event: ScanEvent; tsLabel: string; }

const LogLine = memo(function LogLine({ entry }: { entry: LogEntry }) {
  const color = eventColor(entry.event);
  const isPlain = color === 'var(--text-faint)';
  const trouble = isL2Trouble(entry.event);
  const errorDetail = trouble && typeof entry.event.data?.error === 'string' ? entry.event.data.error : null;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '3px 0', animation: 'fadeIn 150ms cubic-bezier(0.22,1,0.36,1)' }}>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px', flexShrink: 0, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{entry.tsLabel}</span>
      <span style={{ flexShrink: 0, marginTop: 1 }}><EventIcon event={entry.event} /></span>
      <span style={{ fontSize: '12.5px', color: isPlain ? 'var(--text-muted)' : color, lineHeight: 1.4 }}>
        {entry.event.msg}
        {errorDetail && <span style={{ color: 'var(--danger)' }}> — {errorDetail}</span>}
      </span>
    </div>
  );
});

function duration(run: Run): string {
  if (!run.finished_at) return '…';
  const ms = run.finished_at - run.started_at;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// The distillation trail: the run's own numbers narrowing toward the match
// count, brightening as they go (found → L1 survivors → matches). Typographic,
// so it stays honest at any magnitude — no shape to mislead.
function DistillTrail({ run }: { run: Run }) {
  const arrow = <span aria-hidden style={{ fontSize: '11px', color: 'var(--text-faint)', opacity: 0.7 }}>→</span>;
  const matches = run.jobs_l2_pass;
  return (
    <div className="tnum" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 7, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
      <span className="run-trail-stages" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>{run.jobs_found.toLocaleString()}</span>
        {arrow}
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{run.jobs_l1_pass.toLocaleString()}</span>
        {arrow}
      </span>
      <span style={{ fontSize: '17px', lineHeight: 1.15, color: matches > 0 ? 'var(--accent-text)' : 'var(--text-faint)' }}>
        {run.finished_at ? matches.toLocaleString() : '…'}
      </span>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: '10px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
        {run.finished_at ? (matches === 1 ? 'match' : 'matches') : 'running'}
      </span>
    </div>
  );
}

// Raw stage counts live in the tooltip; the row itself tells the distilled story.
// Only the latest run's verdicts are still live — an older run's were wiped by
// every scan since (each re-stamps last_run_id), so its row can't reopen a
// results view; it can only re-run the same query.
function runTooltip(run: Run, isLatest: boolean): string {
  const bits = [
    `${run.jobs_found.toLocaleString()} found`,
    `${run.jobs_new.toLocaleString()} new`,
    `${run.jobs_l1_pass.toLocaleString()} passed L1`,
    `${run.jobs_l2_pass.toLocaleString()} matched`,
  ];
  if (run.errors.length > 0) bits.push(`${run.errors.length} source error${run.errors.length === 1 ? '' : 's'}`);
  const action = isLatest
    ? "view this run's matches"
    : run.query
    ? 'search this again'
    : "this run's matches can't be reconstructed";
  return `${bits.join(' · ')} — ${action}`;
}

function RecentRuns({ runs, onView, onOpenLatest, onRefillQuery }: {
  runs: Run[]; onView: () => void; onOpenLatest: (id: number) => void; onRefillQuery: (query: string) => void;
}) {
  if (runs.length === 0) return null;
  const latestId = runs[0]?.id;
  return (
    <section style={{ marginTop: 'var(--space-3xl)' }}>
      <h2 style={{ margin: '0 0 var(--space-sm)', fontSize: '13px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-ui)' }}>
        Recent runs
      </h2>
      <div style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {/* cap at 5 rows — the home page composition shouldn't scroll; Jobs has the full history */}
        {runs.slice(0, 5).map(run => {
          const isLatest = run.id === latestId;
          const action = () => isLatest ? onOpenLatest(run.id) : run.query && onRefillQuery(run.query);
          return (
            <div
              key={run.id}
              role="button"
              tabIndex={0}
              onClick={action}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } }}
              title={runTooltip(run, isLatest)}
              className="run-row"
              style={{ display: 'grid', gap: 18, padding: '12px 6px', borderBottom: '1px solid var(--border-subtle)', alignItems: 'center', cursor: 'pointer', transition: 'background 140ms ease' }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {run.query || <span style={{ color: 'var(--text-muted)' }}>Re-scan of previous criteria</span>}
                </div>
                <div className="tnum" style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 2 }}>
                  {timeAgo(run.started_at)} · {duration(run)}
                  {run.errors.length > 0 && (
                    <span style={{ color: 'var(--warning)' }}> · {run.errors.length} error{run.errors.length === 1 ? '' : 's'}</span>
                  )}
                </div>
              </div>
              <DistillTrail run={run} />
            </div>
          );
        })}
      </div>
      <button onClick={onView} className="text-link" style={{ marginTop: 'var(--space-md)' }}>
        View all matches <ArrowRight size={14} />
      </button>
      <style>{`
        .text-link{display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:var(--accent-text);font-family:inherit;font-size:13px;font-weight:550;padding:0;}
        .text-link:hover{text-decoration:underline;}
        .run-row{grid-template-columns:minmax(0,1fr) auto;}
        .run-row:hover{background:var(--surface-2);}
        @media (max-width: 700px){
          .run-trail-stages{display:none !important;}
        }
      `}</style>
    </section>
  );
}

// One-shot "ignition" — concentric shockwaves of light + a flash, fired from the
// search bar when a scan starts. Mounted with a fresh key so it restarts each run.
function Ignition() {
  return (
    <div aria-hidden style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, pointerEvents: 'none', zIndex: 3 }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 520, height: 260, transform: 'translate(-50%,-50%)', borderRadius: '50%', background: 'radial-gradient(50% 50% at 50% 50%, var(--orb-1), transparent 70%)', opacity: 0, animation: 'ignite-flash 700ms ease-out both' }} />
      {[0, 130, 260].map((d, i) => (
        <div key={i} style={{ position: 'absolute', left: 0, top: 0, width: 600, height: 600, borderRadius: '50%', border: '2px solid var(--accent)', opacity: 0, animation: `ignite-ring 850ms cubic-bezier(0.22,1,0.36,1) ${d}ms both` }} />
      ))}
    </div>
  );
}

// Cuts a list to `cap` chips + a dim "+N" overflow badge (titled with the
// hidden values) instead of silently dropping them — a criterion L1 still
// applies (e.g. a 4th excluded company) shouldn't vanish from the chips.
function overflowBadge(hidden: string[], key: string) {
  if (hidden.length === 0) return null;
  return (
    <span key={key} title={hidden.join(', ')}>
      <Badge tone="dim">+{hidden.length}</Badge>
    </span>
  );
}

function experienceLabel(e: { min: number | null; max: number | null }): string | null {
  if (e.min == null && e.max == null) return null;
  if (e.min != null && e.max != null) return e.min === e.max ? `${e.min} yrs` : `${e.min}–${e.max} yrs`;
  if (e.min != null) return `${e.min}+ yrs`;
  return `≤ ${e.max} yrs`;
}

// "Here's what Lantern understood" — the structured criteria Claude parsed from
// the natural-language search, so the interpretation is transparent.
function InterpretedChips({ c }: { c: InterpretedCriteria }) {
  const expLabel = c.experience_years ? experienceLabel(c.experience_years) : null;
  const hasAny =
    c.title.positive.length || c.location.remote_required || c.location.allowed.length ||
    c.location.block?.length || c.location.always_allow?.length ||
    c.salary_min_usd || c.seniority.allowed.length || c.title.negative.length ||
    c.exclude_companies.length || expLabel;
  if (!hasAny) return null;
  const positive = c.title.positive.slice(0, 4);
  const allowed = c.location.allowed.slice(0, 3);
  const alwaysAllow = (c.location.always_allow ?? []).slice(0, 2);
  const block = (c.location.block ?? []).slice(0, 3);
  const negative = c.title.negative.slice(0, 3);
  const excluded = c.exclude_companies.slice(0, 3);
  return (
    <div style={{ marginTop: 'var(--space-md)', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', animation: 'fadeIn 220ms ease' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-faint)', marginRight: 2 }}>Understood as</span>
      {positive.map(k => <Badge key={`p-${k}`} tone="accent">{k}</Badge>)}
      {overflowBadge(c.title.positive.slice(4), 'p-more')}
      {c.location.remote_required && <Badge tone="blue">remote</Badge>}
      {allowed.map(l => <Badge key={`l-${l}`} tone="neutral">{l}</Badge>)}
      {overflowBadge(c.location.allowed.slice(3), 'l-more')}
      {alwaysAllow.map(l => <Badge key={`aa-${l}`} tone="neutral">always {l}</Badge>)}
      {overflowBadge((c.location.always_allow ?? []).slice(2), 'aa-more')}
      {block.map(l => <Badge key={`bl-${l}`} tone="danger">not {l}</Badge>)}
      {overflowBadge((c.location.block ?? []).slice(3), 'bl-more')}
      {c.salary_min_usd ? <Badge tone="success">≥ {formatMoney(c.salary_min_usd, c.salary_currency)}</Badge> : null}
      {expLabel && <Badge tone="violet">{expLabel}</Badge>}
      {c.seniority.allowed.map(s => <Badge key={`s-${s}`} tone="violet">{s}</Badge>)}
      {negative.map(n => <Badge key={`n-${n}`} tone="danger">no {n}</Badge>)}
      {overflowBadge(c.title.negative.slice(3), 'n-more')}
      {excluded.map(x => <Badge key={`x-${x}`} tone="danger">not {x}</Badge>)}
      {overflowBadge(c.exclude_companies.slice(3), 'x-more')}
    </div>
  );
}

// Rotated through the hero input — for an NL-driven search the placeholder is
// also teaching: it shows the breadth of what the parser understands.
const PLACEHOLDERS = [
  'e.g. Senior backend engineer, remote in Europe, $120k+',
  'Staff platform engineer, SF or remote US, no agencies',
  'Flutter developer, Berlin or remote EU, €70k+',
  'ML engineer, remote, $150k+, no crypto',
];

export default function SearchPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [phIdx, setPhIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const [igniteAt, setIgniteAt] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [lastResult, setLastResult] = useState<Run | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [interpreted, setInterpreted] = useState<InterpretedCriteria | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const logCounter = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadRuns = useCallback(async () => {
    const res = await api.runs.list(10);
    setRuns(res.runs);
    setLoadingRuns(false);
    return res.runs;
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const { queries } = await api.runs.recentQueries();
      setRecent(queries);
    } catch { /* dropdown just stays empty */ }
  }, []);

  // On mount, reconnect to an in-progress scan if one is running (e.g. the user
  // navigated away and came back) so live progress resumes instead of the page
  // looking idle/complete. A run is in-progress while finished_at is null — and
  // the server now recovers runs orphaned by a crash at boot (marks them
  // finished), so an unfinished row here really is a live run, never a stale one.
  useEffect(() => {
    loadRuns().then(rs => {
      const active = rs.find(r => !r.finished_at);
      if (active) { setActiveRunId(active.id); setScanning(true); }
    });
    loadRecent();
  }, [loadRuns, loadRecent]);

  const { reconnecting } = useSSE(activeRunId, (event: ScanEvent) => {
    setLog(prev => [...prev, { id: logCounter.current++, event, tsLabel: formatTs(Date.now()) }]);
    // 'scan_done' is the L1→L2 handoff (not terminal); keep showing progress.
    // The run is finished only on 'l2_done' (or 'done' for an already-finished
    // run, or 'error').
    if (event.type === 'l2_done' || event.type === 'done' || event.type === 'error') {
      setScanError(event.type === 'error' ? event.msg : null);
      const id = activeRunId ?? event.runId;
      Promise.resolve(id ? api.runs.get(id) : null)
        .then(run => setLastResult(run))
        .catch(() => { /* the roster reload below still keeps recent runs fresh */ });
      loadRuns();
      loadRecent();
      setScanning(false);
    }
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Polling backstop: the SSE stream is the primary signal, but if it drops and
  // can't recover we'd be stuck showing "Scanning" forever. While scanning, poll
  // THIS run specifically (never "the latest run" — a new search's own run row
  // doesn't exist yet a few seconds in, while nl-filter is still interpreting
  // the query, so "latest" would still be the previous, already-finished run).
  useEffect(() => {
    if (!scanning || activeRunId === null) return;
    const iv = setInterval(async () => {
      try {
        const run = await api.runs.get(activeRunId);
        if (run.finished_at) {
          setLastResult(run);
          setScanning(false);
          loadRuns();
          loadRecent();
        }
      } catch { /* transient — try again next tick */ }
    }, 4000);
    return () => clearInterval(iv);
  }, [scanning, activeRunId, loadRuns, loadRecent]);

  // The raw query drives the search. The backend interprets it into criteria via
  // Claude (location, salary, seniority, exclusions — all from the sentence), so
  // there's nothing to persist client-side.
  const handleScan = async () => {
    if (scanning) return;
    const query = keyword.trim();
    if (!query) return;
    setShowRecent(false);
    setIgniteAt(Date.now());
    setScanning(true);
    setLog([]);
    setLastResult(null);
    setScanError(null);
    setInterpreted(null);
    setActiveRunId(null);
    // Stay in the scanning state until the 202 comes back with the run id —
    // there's no run row to poll or reconnect to before then.
    try {
      const res = await api.runs.startScan(query);
      setInterpreted(res.criteria);
      setActiveRunId(res.runId);
    } catch (err) {
      setScanning(false);
      const msg = String(err);
      setScanError(msg);
      setLog(prev => [...prev, { id: logCounter.current++, event: { runId: 0, type: 'error', msg }, tsLabel: formatTs(Date.now()) }]);
    }
  };

  // Cycle the example query while the input is empty (interval matches the
  // ph-cycle keyframe duration so each example fades out before swapping).
  useEffect(() => {
    if (keyword) return;
    const iv = setInterval(() => setPhIdx(i => (i + 1) % PLACEHOLDERS.length), 4200);
    return () => clearInterval(iv);
  }, [keyword]);

  const suggestions = recent
    .filter(q => q.toLowerCase() !== keyword.trim().toLowerCase())
    .filter(q => keyword.trim() === '' || q.toLowerCase().includes(keyword.trim().toLowerCase()))
    .slice(0, 5);
  // Clamp against the live list — it re-filters as you type, so a stale index
  // from a longer list must not point past the end (or linger when it's gone).
  const activeSuggestion = activeIdx >= 0 && activeIdx < suggestions.length ? activeIdx : -1;

  const pickSuggestion = (q: string) => {
    setKeyword(q);
    setShowRecent(false);
    setActiveIdx(-1);
    inputRef.current?.focus();
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: '100vh', maxWidth: 740, margin: '0 auto', padding: '0 var(--space-xl)' }}>
      {/* auto vertical margins center the hero composition while content is light;
          they collapse to 0 as the log / runs grow, restoring normal flow */}
      <div style={{ position: 'relative', margin: 'auto 0', padding: 'var(--space-2xl) 0' }}>
      {/* abstract lantern-glow backdrop — a single soft orb + rising embers. The
          search bar's halo is the focal light; one quiet counterweight upper-left
          is all the orb work this composition needs (a second top-right orb fought
          the halo for attention). Brightens as you engage the search. */}
      <div aria-hidden style={{
        position: 'absolute', inset: '-180px -80px auto -80px', height: 580, pointerEvents: 'none', zIndex: 0,
        filter: (focused || keyword.trim()) ? 'brightness(1.22) saturate(1.1)' : 'none',
        transition: 'filter 800ms ease',
      }}>
        {/* orb blends via --deco-blend (multiply on light paper) so it reads as light */}
        <div style={{ position: 'absolute', inset: 0, mixBlendMode: 'var(--deco-blend)' as CSSProperties['mixBlendMode'] }}>
          <div style={{ position: 'absolute', top: 60, left: '12%', width: 420, height: 360, willChange: 'transform', background: 'radial-gradient(50% 50% at 50% 50%, var(--orb-2), transparent 70%)', filter: 'blur(12px)', animation: 'rise 900ms cubic-bezier(0.22,1,0.36,1) 120ms both, drift-b 21s ease-in-out 1s infinite' }} />
        </div>
        <Embers />
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
      <header style={{ marginBottom: 'var(--space-xl)' }}>
        <h1 style={{ margin: '0 0 var(--space-md)', fontSize: 'clamp(36px, 5.6vw, 60px)', fontWeight: 500, color: 'var(--text)', lineHeight: 1.04, letterSpacing: '-0.015em', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) both' }}>
          What <em style={{ fontStyle: 'italic', color: 'var(--accent-2)', fontWeight: 500 }}>role</em> are you<br />looking for?
        </h1>
        <p style={{ margin: 0, fontSize: '16px', color: 'var(--text-muted)', maxWidth: '52ch', lineHeight: 1.55, fontFamily: 'var(--font-ui)', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) 90ms both' }}>
          Describe it in plain English. Lantern searches 300+ company boards and
          live aggregators, then filters and scores the matches.
        </p>
      </header>

      <div className="hero-bar" style={{ position: 'relative', display: 'flex', gap: 'var(--space-sm)', alignItems: 'stretch', animation: 'rise 500ms cubic-bezier(0.22,1,0.36,1) 160ms both' }}>
        {/* centered ambient halo behind the whole bar — a soft layered nebula of
            lantern light that breathes at rest and steadies awake on focus */}
        <div className="hero-halo" aria-hidden />
        {igniteAt > 0 && <Ignition key={igniteAt} />}
        <div className="hero-wrap" style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <input
            ref={inputRef}
            aria-label="Describe the role you want"
            role="combobox"
            aria-expanded={showRecent && suggestions.length > 0}
            aria-controls="recent-searches"
            aria-activedescendant={activeSuggestion >= 0 ? `recent-option-${activeSuggestion}` : undefined}
            value={keyword}
            onChange={e => { setKeyword(e.target.value); setShowRecent(true); setActiveIdx(-1); }}
            onFocus={() => setFocused(true)}
            onClick={() => setShowRecent(true)}
            onBlur={() => { setFocused(false); window.setTimeout(() => { setShowRecent(false); setActiveIdx(-1); }, 150); }}
            onKeyDown={e => {
              const open = showRecent && suggestions.length > 0;
              if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setActiveIdx(i => {
                  const cur = i >= 0 && i < suggestions.length ? i : -1;
                  const n = suggestions.length;
                  if (e.key === 'ArrowDown') return cur < n - 1 ? cur + 1 : 0;
                  return cur > 0 ? cur - 1 : n - 1;
                });
              } else if (e.key === 'Enter') {
                if (open && activeSuggestion >= 0) { pickSuggestion(suggestions[activeSuggestion]); }
                else handleScan();
              } else if (e.key === 'Escape') {
                setShowRecent(false);
                setActiveIdx(-1);
              }
            }}
            disabled={scanning}
            autoFocus
            className="hero-input"
            style={{ width: '100%' }}
          />
          {/* custom placeholder layer — a native placeholder can't crossfade */}
          {!keyword && !scanning && (
            <span aria-hidden style={{ position: 'absolute', inset: 1, zIndex: 2, display: 'flex', alignItems: 'center', padding: '0 22px', pointerEvents: 'none', overflow: 'hidden' }}>
              <span key={phIdx} className="ph-cycle" style={{ color: 'var(--text-faint)', fontSize: '19px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {PLACEHOLDERS[phIdx]}
              </span>
            </span>
          )}
          {showRecent && !scanning && suggestions.length > 0 && (
            <div id="recent-searches" role="listbox" aria-label="Recent searches" className="recent-pop">
              {suggestions.map((q, i) => (
                <button
                  key={i}
                  id={`recent-option-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeSuggestion}
                  className={`recent-item${i === activeSuggestion ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onMouseDown={e => { e.preventDefault(); pickSuggestion(q); }}
                >
                  <Clock size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Button
          size="md"
          onClick={() => handleScan()}
          disabled={scanning || !keyword.trim()}
          loading={scanning}
          style={{
            padding: '0 28px', fontSize: '16px', flexShrink: 0, height: 'auto', alignSelf: 'stretch', borderRadius: 'var(--radius-lg)',
            // empty-query idle reads "ready when you type", not broken: dim fill, legible label
            ...(!scanning && !keyword.trim() ? { opacity: 1, background: 'color-mix(in oklch, var(--accent) 30%, var(--surface))', color: 'var(--text-muted)' } : {}),
          }}
        >
          {scanning ? 'Scanning' : 'Search'}
          {!scanning && <ArrowRight size={16} strokeWidth={2.25} />}
        </Button>
        <style>{`
          .hero-input {
            position: relative;
            z-index: 1;
            background: var(--surface);
            border: 1px solid color-mix(in oklch, var(--border) 75%, transparent);
            border-radius: var(--radius-lg);
            color: var(--text);
            font-family: var(--font-ui);
            font-size: 19px;
            padding: 19px 22px;
            outline: none;
            transition: border-color 150ms ease, box-shadow 150ms ease;
          }
          .hero-input::placeholder { color: var(--text-faint); }
          .hero-input:focus { border-color: color-mix(in oklch, var(--accent) 55%, var(--border)); box-shadow: 0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent), 0 18px 48px -18px color-mix(in oklch, var(--accent) 60%, transparent); }
          .hero-input:disabled { opacity: 0.6; }
          .hero-halo {
            position: absolute; left: 50%; top: 50%; z-index: 0;
            width: calc(100% + 440px); height: 540px;
            transform: translate(-50%, -50%);
            pointer-events: none;
            mix-blend-mode: var(--deco-blend);
            background:
              radial-gradient(44% 50% at 50% 52%, color-mix(in oklch, var(--accent) 32%, transparent), transparent 72%),
              radial-gradient(78% 96% at 50% 50%, color-mix(in oklch, var(--accent-2) 15%, transparent), transparent 80%);
            filter: blur(30px);
            opacity: 0.6;
            animation: halo-breathe 6.5s ease-in-out infinite;
            transition: opacity 400ms ease;
          }
          .hero-bar:focus-within .hero-halo { animation: none; opacity: 1; }
          .ph-cycle { animation: ph-cycle 4.2s ease both; }
          @media (prefers-reduced-motion: reduce) {
            .ph-cycle { animation: none; opacity: 1; }
          }
          .recent-pop {
            position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 5;
            background: var(--surface); border: 1px solid var(--border);
            border-radius: var(--radius-lg); box-shadow: var(--shadow-md);
            padding: 4px; overflow: hidden;
          }
          .recent-item {
            display: flex; align-items: center; gap: 9px; width: 100%;
            padding: 9px 12px; background: none; border: none;
            border-radius: var(--radius-md); cursor: pointer;
            color: var(--text); font-family: var(--font-ui); font-size: 14px; text-align: left;
          }
          .recent-item:hover, .recent-item.active { background: var(--surface-2); }
        `}</style>
      </div>
      <p style={{ margin: 'var(--space-sm) 0 0', fontSize: '12.5px', color: 'var(--text-faint)' }}>
        Plain English works — Lantern reads the role, location, salary, and exclusions from your search.
      </p>

      {interpreted && <InterpretedChips c={interpreted} />}

      {scanning && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <div style={{ position: 'relative', height: 3, borderRadius: 'var(--radius-full)', background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: '30%', borderRadius: 'var(--radius-full)', background: 'linear-gradient(90deg, transparent, var(--accent), transparent)', animation: 'sweep 1.3s cubic-bezier(0.45,0,0.55,1) infinite' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 'var(--space-sm)', fontSize: '13.5px', color: 'var(--text-muted)' }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', animation: 'glow-pulse 1.4s ease-in-out infinite' }} />
            Fetching sources and scoring matches…
          </div>
          {reconnecting && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: '12.5px', color: 'var(--warning)' }}>
              <Spinner size={12} /> Reconnecting…
            </div>
          )}
        </div>
      )}

      {(scanning || log.length > 0) && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <div ref={logRef} style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1, paddingRight: 4 }}>
            {log.length === 0 && scanning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-faint)', fontSize: '12.5px' }}>
                <Spinner size={12} /> Connecting…
              </div>
            )}
            {/* render only the tail — a scan emits ~1.5-2K events and formatting/
                mounting every line each render was O(n^2); the full count still
                accumulates in state, just not all painted */}
            {(log.length > 300 ? log.slice(log.length - 300) : log).map(entry => <LogLine key={entry.id} entry={entry} />)}
          </div>
        </div>
      )}

      {scanError && !scanning && (
        <div style={{ marginTop: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 8, fontSize: '13.5px', color: 'var(--danger)' }}>
          <XCircle size={15} /> {scanError}
        </div>
      )}

      {lastResult && !scanning && (
        <div style={{ marginTop: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '14px', color: 'var(--text)' }}>
            Found <strong className="tnum">{lastResult.jobs_found.toLocaleString()}</strong>,{' '}
            <strong className="tnum">{lastResult.jobs_new.toLocaleString()}</strong> new ·{' '}
            <span className="tnum" style={{ color: 'var(--text-muted)' }}>L1 {lastResult.jobs_l1_pass.toLocaleString()} · L2 {lastResult.jobs_l2_pass.toLocaleString()}</span>
          </span>
          <Button size="sm" variant="outline" onClick={() => navigate('/jobs?fit=1&run=latest')}>
            View matches <ArrowRight size={14} />
          </Button>
        </div>
      )}

      {loadingRuns ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner /></div>
      ) : (
        <RecentRuns
          runs={runs}
          onView={() => navigate('/jobs?fit=1')}
          onOpenLatest={id => navigate(`/jobs?run=${id}&fit=1`)}
          onRefillQuery={q => { setKeyword(q); inputRef.current?.focus(); }}
        />
      )}

      {!loadingRuns && runs.length === 0 && !scanning && log.length === 0 && (
        <div style={{ marginTop: 'var(--space-2xl)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '32px 0', textAlign: 'center', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) 240ms both' }}>
          <EmptyLantern size={120} dim />
          <p style={{ color: 'var(--text)', fontSize: '15px', margin: 0, fontFamily: 'var(--font-serif)' }}>Nothing scanned <em style={{ color: 'var(--accent-2)' }}>yet</em></p>
          <p style={{ color: 'var(--text-faint)', fontSize: '13px', margin: 0, maxWidth: '40ch' }}>
            Describe a role above and Lantern will light up matching jobs across every board.
          </p>
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
