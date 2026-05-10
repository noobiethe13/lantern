import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Circle, CheckCircle2, XCircle, Sparkles, Flag,
  Clock, AlertTriangle, BarChart3,
} from 'lucide-react';
import { api, type Run } from '@/lib/api';
import { useSSE, type ScanEvent } from '@/lib/sse';
import { Button, Spinner } from '@/components/ui';

// ─── Event icon + color map ────────────────────────────────────────────────────

function EventIcon({ type }: { type: ScanEvent['type'] }) {
  const props = { size: 13 };
  switch (type) {
    case 'source_start':  return <Circle {...props} style={{ color: 'var(--text-faint)' }} />;
    case 'source_done':   return <CheckCircle2 {...props} style={{ color: 'var(--success)' }} />;
    case 'source_error':  return <XCircle {...props} style={{ color: 'var(--danger)' }} />;
    case 'l2_progress':   return <Sparkles {...props} style={{ color: 'var(--accent-hover)' }} />;
    case 'l2_start':      return <BarChart3 {...props} style={{ color: 'var(--accent)' }} />;
    case 'l2_done':       return <BarChart3 {...props} style={{ color: 'var(--success)' }} />;
    case 'done':          return <Flag {...props} style={{ color: 'var(--success)' }} />;
    case 'error':         return <XCircle {...props} style={{ color: 'var(--danger)' }} />;
    default:              return <Circle {...props} style={{ color: 'var(--text-faint)' }} />;
  }
}

// ─── Log entry ────────────────────────────────────────────────────────────────

interface LogEntry {
  id: number;
  event: ScanEvent;
  ts: number;
}

function LogLine({ entry }: { entry: LogEntry }) {
  const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const isError = entry.event.type === 'source_error' || entry.event.type === 'error';
  const isDone = entry.event.type === 'done' || entry.event.type === 'l2_done';

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '4px 0',
        animation: 'fadeIn 150ms ease-out',
        opacity: isDone ? 1 : isError ? 0.9 : 1,
      }}
    >
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: '11px', flexShrink: 0, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
        {ts}
      </span>
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        <EventIcon type={entry.event.type} />
      </span>
      <span style={{
        fontSize: '12px',
        color: isError ? 'var(--danger)' : isDone ? 'var(--success)' : 'var(--text-muted)',
        lineHeight: 1.4,
      }}>
        {entry.event.msg}
      </span>
    </div>
  );
}

// ─── Recent runs table ────────────────────────────────────────────────────────

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

function RecentRuns({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return null;

  return (
    <div style={{ marginTop: 40 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Recent runs
      </h2>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '10px', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px 70px 60px 50px', gap: 16, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          {['When', 'Found', 'New', 'L1', 'L2', 'Time', 'Errors'].map(h => (
            <span key={h} style={{ fontSize: '11px', color: 'var(--text-faint)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</span>
          ))}
        </div>
        {runs.slice(0, 10).map((run, i) => (
          <div
            key={run.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 70px 70px 70px 70px 60px 50px',
              gap: 16, padding: '9px 16px',
              borderBottom: i < runs.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            }}
          >
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{timeAgo(run.started_at)}</span>
            {[run.jobs_found, run.jobs_new, run.jobs_l1_pass, run.jobs_l2_pass].map((n, j) => (
              <span key={j} style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                {n}
              </span>
            ))}
            <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {duration(run)}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: run.errors.length > 0 ? 'var(--warning)' : 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
              {run.errors.length > 0 ? run.errors.length : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RunPage() {
  const [scanning, setScanning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const logCounter = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  const loadRuns = useCallback(async () => {
    const res = await api.runs.list(10);
    setRuns(res.runs);
    setLoadingRuns(false);
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Wire SSE
  useSSE(activeRunId, (event: ScanEvent) => {
    setLog(prev => [...prev, { id: logCounter.current++, event, ts: Date.now() }]);

    if (event.type === 'done' || event.type === 'l2_done') {
      // Reload runs list after completion
      loadRuns();
    }

    if (event.type === 'l2_done' || (event.type === 'done' && !activeRunId)) {
      setScanning(false);
    }
  });

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const handleScan = async () => {
    setScanning(true);
    setLog([]);
    setActiveRunId(null);

    try {
      await api.runs.startScan();
      // Poll to get the run_id
      let retries = 10;
      while (retries-- > 0) {
        await new Promise(r => setTimeout(r, 600));
        const { runs: freshRuns } = await api.runs.list(1);
        if (freshRuns[0] && !freshRuns[0].finished_at) {
          setActiveRunId(freshRuns[0].id);
          break;
        }
      }
    } catch (err) {
      setScanning(false);
      setLog(prev => [...prev, {
        id: logCounter.current++,
        event: { runId: 0, type: 'error', msg: String(err) },
        ts: Date.now(),
      }]);
    }
  };

  const lastRun = runs[0];
  const statusLine = scanning
    ? null
    : lastRun?.finished_at
    ? timeAgo(lastRun.finished_at)
    : null;

  return (
    <div style={{ padding: '32px 32px', maxWidth: 760 }}>
      {/* Header */}
      <div style={{ marginBottom: 32, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.02em' }}>
            Run
          </h1>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
            Scan all enabled sources and score matches with Gemini.
          </p>
        </div>

        {statusLine && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: 'var(--text-faint)' }}>
            <Clock size={12} />
            Last scan {statusLine}
          </div>
        )}
      </div>

      {/* Scan button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
        <Button
          size="md"
          onClick={handleScan}
          disabled={scanning}
          loading={scanning}
          style={{
            padding: '10px 24px',
            fontSize: '14px',
            height: 'auto',
            borderRadius: '9px',
            gap: 8,
          }}
        >
          {!scanning && <Play size={15} strokeWidth={2.5} />}
          {scanning ? 'Scanning…' : 'Run Scan'}
        </Button>

        {scanning && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px', color: 'var(--text-muted)' }}>
            <Spinner size={14} />
            Fetching sources, scoring with Gemini…
          </div>
        )}
      </div>

      {/* Live log */}
      {(scanning || log.length > 0) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: '11px', color: 'var(--text-faint)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
            Live log
          </div>
          <div
            ref={logRef}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '12px 16px',
              maxHeight: 340,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              fontFamily: 'var(--mono)',
            }}
          >
            {log.length === 0 && scanning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-faint)', fontSize: '12px' }}>
                <Spinner size={12} />
                Connecting…
              </div>
            )}
            {log.map(entry => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {/* Recent runs */}
      {loadingRuns ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '32px 0' }}>
          <Spinner />
        </div>
      ) : (
        <RecentRuns runs={runs} />
      )}

      {/* Empty state — no runs yet */}
      {!loadingRuns && runs.length === 0 && !scanning && (
        <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 0' }}>
          <AlertTriangle size={20} style={{ color: 'var(--text-faint)' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0 }}>No scans run yet.</p>
          <p style={{ color: 'var(--text-faint)', fontSize: '12px', margin: 0 }}>Configure your criteria in Settings, then run a scan.</p>
        </div>
      )}
    </div>
  );
}
