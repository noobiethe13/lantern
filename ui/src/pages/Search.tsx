import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import yaml from 'js-yaml';
import {
  ArrowRight, Circle, CheckCircle2, XCircle, Sparkles, Flag,
  BarChart3,
} from 'lucide-react';
import { api, type Run, type Criteria } from '@/lib/api';
import { useSSE, type ScanEvent } from '@/lib/sse';
import { Button, Spinner } from '@/components/ui';
import { EmptyLantern, Embers } from '@/components/brand';

function eventColor(type: ScanEvent['type']): string {
  switch (type) {
    case 'source_done': case 'l2_done': case 'done': return 'var(--success)';
    case 'source_error': case 'error': return 'var(--danger)';
    case 'l2_progress': case 'l2_start': return 'var(--accent-text)';
    default: return 'var(--text-faint)';
  }
}

function EventIcon({ type }: { type: ScanEvent['type'] }) {
  const p = { size: 13, style: { color: eventColor(type) } };
  switch (type) {
    case 'source_done': return <CheckCircle2 {...p} />;
    case 'source_error': case 'error': return <XCircle {...p} />;
    case 'l2_progress': return <Sparkles {...p} />;
    case 'l2_start': case 'l2_done': return <BarChart3 {...p} />;
    case 'done': return <Flag {...p} />;
    default: return <Circle {...p} />;
  }
}

interface LogEntry { id: number; event: ScanEvent; ts: number; }

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const color = eventColor(entry.event.type);
  const isPlain = color === 'var(--text-faint)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '3px 0', animation: 'fadeIn 150ms cubic-bezier(0.22,1,0.36,1)' }}>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px', flexShrink: 0, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{ts}</span>
      <span style={{ flexShrink: 0, marginTop: 1 }}><EventIcon type={entry.event.type} /></span>
      <span style={{ fontSize: '12.5px', color: isPlain ? 'var(--text-muted)' : color, lineHeight: 1.4 }}>{entry.event.msg}</span>
    </div>
  );
}

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

function RecentRuns({ runs, onView }: { runs: Run[]; onView: () => void }) {
  if (runs.length === 0) return null;
  const cols = '1fr 60px 60px 56px 56px 60px 56px';
  return (
    <section style={{ marginTop: 'var(--space-3xl)' }}>
      <h2 style={{ margin: '0 0 var(--space-md)', fontSize: '13px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-ui)' }}>
        Recent runs
      </h2>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, padding: '0 4px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
        {['When', 'Found', 'New', 'L1', 'L2', 'Time', 'Errors'].map(h => (
          <span key={h} style={{ fontSize: '11px', color: 'var(--text-faint)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</span>
        ))}
      </div>
      {runs.slice(0, 10).map(run => (
        <div key={run.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, padding: '10px 4px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</span>
          {[run.jobs_found, run.jobs_new, run.jobs_l1_pass, run.jobs_l2_pass].map((n, j) => (
            <span key={j} className="tnum" style={{ fontSize: '12.5px', color: 'var(--text)' }}>{n.toLocaleString()}</span>
          ))}
          <span className="tnum" style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>{duration(run)}</span>
          <span className="tnum" style={{ fontSize: '12.5px', color: run.errors.length > 0 ? 'var(--warning)' : 'var(--text-faint)' }}>
            {run.errors.length > 0 ? run.errors.length : '—'}
          </span>
        </div>
      ))}
      <button onClick={onView} className="text-link" style={{ marginTop: 'var(--space-md)' }}>
        View all matches <ArrowRight size={14} />
        <style>{`.text-link{display:inline-flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;color:var(--accent-text);font-family:inherit;font-size:13px;font-weight:550;padding:0;}.text-link:hover{text-decoration:underline;}`}</style>
      </button>
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

export default function SearchPage() {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [focused, setFocused] = useState(false);
  const [igniteAt, setIgniteAt] = useState(0);
  const [criteriaLoaded, setCriteriaLoaded] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [lastResult, setLastResult] = useState<Run | null>(null);
  const logCounter = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadRuns = useCallback(async () => {
    const res = await api.runs.list(10);
    setRuns(res.runs);
    setLoadingRuns(false);
  }, []);

  useEffect(() => {
    loadRuns();
    api.criteria.get().then((c: Criteria) => {
      try {
        const parsed = (yaml.load(c.yaml) ?? {}) as { title?: { positive?: string[] } };
        const pos = parsed.title?.positive ?? [];
        if (pos.length) setKeyword(pos.join(', '));
      } catch { /* keep blank on malformed yaml */ }
      setCriteriaLoaded(true);
    }).catch(() => setCriteriaLoaded(true));
  }, [loadRuns]);

  useSSE(activeRunId, (event: ScanEvent) => {
    setLog(prev => [...prev, { id: logCounter.current++, event, ts: Date.now() }]);
    if (event.type === 'done' || event.type === 'l2_done') {
      loadRuns().then(() => {
        api.runs.list(1).then(r => setLastResult(r.runs[0] ?? null));
      });
      setScanning(false);
    }
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Persist the role into criteria.title.positive (the title-driven search term)
  // before scanning, preserving the rest of the criteria document.
  const persistKeyword = async () => {
    const kws = keyword.split(',').map(s => s.trim()).filter(Boolean);
    const current = await api.criteria.get();
    let doc: Record<string, unknown> = {};
    try { doc = (yaml.load(current.yaml) ?? {}) as Record<string, unknown>; } catch { doc = {}; }
    const title = (doc.title ?? {}) as { positive?: string[]; negative?: string[] };
    doc.title = { positive: kws, negative: title.negative ?? [] };
    await api.criteria.save(yaml.dump(doc));
  };

  const handleScan = async () => {
    if (scanning) return;
    setIgniteAt(Date.now());
    setScanning(true);
    setLog([]);
    setLastResult(null);
    setActiveRunId(null);
    try {
      if (keyword.trim()) await persistKeyword();
      await api.runs.startScan();
      let retries = 12;
      while (retries-- > 0) {
        await new Promise(r => setTimeout(r, 600));
        const { runs: fresh } = await api.runs.list(1);
        if (fresh[0] && !fresh[0].finished_at) { setActiveRunId(fresh[0].id); break; }
      }
    } catch (err) {
      setScanning(false);
      setLog(prev => [...prev, { id: logCounter.current++, event: { runId: 0, type: 'error', msg: String(err) }, ts: Date.now() }]);
    }
  };

  return (
    <div style={{ position: 'relative', padding: 'var(--space-3xl) var(--space-xl)', maxWidth: 740, margin: '0 auto' }}>
      {/* abstract lantern-glow backdrop — drifting orbs, rotating rings, rising embers.
          Brightens as you engage the search (focus / typing). No clip → no hard edges
          (horizontal bleed is contained by the main's overflow-x). */}
      <div aria-hidden style={{
        position: 'absolute', inset: '-160px -80px auto -80px', height: 580, pointerEvents: 'none', zIndex: 0,
        filter: (focused || keyword.trim()) ? 'brightness(1.22) saturate(1.1)' : 'none',
        transition: 'filter 800ms ease',
      }}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <div style={{ position: 'absolute', top: -40, left: '46%', width: 600, height: 500, willChange: 'transform', background: 'radial-gradient(50% 50% at 50% 50%, var(--orb-1), transparent 70%)', filter: 'blur(8px)', animation: 'rise 900ms cubic-bezier(0.22,1,0.36,1) both, drift-a 17s ease-in-out 900ms infinite' }} />
          <div style={{ position: 'absolute', top: 60, left: '12%', width: 420, height: 360, willChange: 'transform', background: 'radial-gradient(50% 50% at 50% 50%, var(--orb-2), transparent 70%)', filter: 'blur(12px)', animation: 'rise 900ms cubic-bezier(0.22,1,0.36,1) 120ms both, drift-b 21s ease-in-out 1s infinite' }} />
        </div>
        <Embers />
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
      <header style={{ marginBottom: 'var(--space-xl)' }}>
        <h1 style={{ margin: '0 0 var(--space-md)', fontSize: 'clamp(36px, 5.6vw, 60px)', fontWeight: 500, color: 'var(--text)', lineHeight: 1.04, letterSpacing: '-0.015em', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) both' }}>
          What <em style={{ fontStyle: 'italic', color: 'var(--accent-2)', fontWeight: 500 }}>role</em> are you looking for?
        </h1>
        <p style={{ margin: 0, fontSize: '16px', color: 'var(--text-muted)', maxWidth: '50ch', lineHeight: 1.55, fontFamily: 'var(--font-ui)', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) 90ms both' }}>
          Lantern searches 300+ company boards and live aggregators for your title,
          then filters and scores the matches.
        </p>
      </header>

      <div style={{ position: 'relative', display: 'flex', gap: 'var(--space-sm)', alignItems: 'stretch', animation: 'rise 500ms cubic-bezier(0.22,1,0.36,1) 160ms both' }}>
        {igniteAt > 0 && <Ignition key={igniteAt} />}
        <input
          ref={inputRef}
          aria-label="Role or job title to search for"
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={e => { if (e.key === 'Enter') handleScan(); }}
          placeholder={criteriaLoaded ? 'e.g. Node Developer, Backend Engineer' : 'Loading…'}
          disabled={!criteriaLoaded || scanning}
          autoFocus
          className="hero-input"
        />
        <Button
          size="md"
          onClick={handleScan}
          disabled={scanning || !criteriaLoaded}
          loading={scanning}
          style={{ padding: '0 24px', fontSize: '15px', flexShrink: 0, height: 'auto', alignSelf: 'stretch', borderRadius: 'var(--radius-lg)' }}
        >
          {scanning ? 'Scanning' : 'Search'}
          {!scanning && <ArrowRight size={16} strokeWidth={2.25} />}
        </Button>
        <style>{`
          .hero-input {
            flex: 1; min-width: 0;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            color: var(--text);
            font-family: var(--font-ui);
            font-size: 17px;
            padding: 14px 18px;
            outline: none;
            transition: border-color 150ms ease, box-shadow 150ms ease;
          }
          .hero-input::placeholder { color: var(--text-faint); }
          .hero-input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-ring); }
          .hero-input:disabled { opacity: 0.6; }
        `}</style>
      </div>
      <p style={{ margin: 'var(--space-sm) 0 0', fontSize: '12.5px', color: 'var(--text-faint)' }}>
        Separate multiple titles with commas. Fine-tune locations, salary, and exclusions in{' '}
        <button onClick={() => navigate('/settings')} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-text)', cursor: 'pointer', font: 'inherit' }}>Settings</button>.
      </p>

      {scanning && (
        <div style={{ marginTop: 'var(--space-lg)' }}>
          <div style={{ position: 'relative', height: 3, borderRadius: 'var(--radius-full)', background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: '30%', borderRadius: 'var(--radius-full)', background: 'linear-gradient(90deg, transparent, var(--accent), transparent)', animation: 'sweep 1.3s cubic-bezier(0.45,0,0.55,1) infinite' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 'var(--space-sm)', fontSize: '13.5px', color: 'var(--text-muted)' }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', animation: 'glow-pulse 1.4s ease-in-out infinite' }} />
            Fetching sources and scoring matches…
          </div>
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
            {log.map(entry => <LogLine key={entry.id} entry={entry} />)}
          </div>
        </div>
      )}

      {lastResult && !scanning && (
        <div style={{ marginTop: 'var(--space-lg)', display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '14px', color: 'var(--text)' }}>
            Found <strong className="tnum">{lastResult.jobs_found.toLocaleString()}</strong>,{' '}
            <strong className="tnum">{lastResult.jobs_new.toLocaleString()}</strong> new ·{' '}
            <span className="tnum" style={{ color: 'var(--text-muted)' }}>L1 {lastResult.jobs_l1_pass.toLocaleString()} · L2 {lastResult.jobs_l2_pass.toLocaleString()}</span>
          </span>
          <Button size="sm" variant="outline" onClick={() => navigate('/jobs?l2=1')}>
            View matches <ArrowRight size={14} />
          </Button>
        </div>
      )}

      {loadingRuns ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}><Spinner /></div>
      ) : (
        <RecentRuns runs={runs} onView={() => navigate('/jobs')} />
      )}

      {!loadingRuns && runs.length === 0 && !scanning && log.length === 0 && (
        <div style={{ marginTop: 'var(--space-2xl)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '32px 0', textAlign: 'center', animation: 'rise 600ms cubic-bezier(0.22,1,0.36,1) 240ms both' }}>
          <EmptyLantern size={120} dim />
          <p style={{ color: 'var(--text)', fontSize: '15px', margin: 0, fontFamily: 'var(--font-serif)' }}>Nothing scanned <em style={{ color: 'var(--accent-2)' }}>yet</em></p>
          <p style={{ color: 'var(--text-faint)', fontSize: '13px', margin: 0, maxWidth: '38ch' }}>
            Name a role above and Lantern will light up matching jobs across every board.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
