import {
  useState, useEffect, useCallback, useRef,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, ExternalLink, Search,
  MapPin, Globe, SlidersHorizontal, X,
} from 'lucide-react';
import { api, type Job, type JobStatus } from '@/lib/api';
import { Button, Input, Textarea, Spinner } from '@/components/ui';
import { StatusPill } from '@/components/StatusPill';
import { ScoreBar } from '@/components/ScoreBar';

// ─── Filter bar ───────────────────────────────────────────────────────────────

const STATUS_TABS: { label: string; value: string }[] = [
  { label: 'All', value: '' },
  { label: 'New', value: 'new' },
  { label: 'Shortlisted', value: 'shortlist' },
  { label: 'Applied', value: 'applied' },
  { label: 'Interview', value: 'interview' },
  { label: 'Offer', value: 'offer' },
];

function FilterBar({
  status, l1, l2, q,
  onStatus, onL1, onL2, onQ,
}: {
  status: string; l1: boolean; l2: boolean; q: string;
  onStatus: (v: string) => void;
  onL1: (v: boolean) => void;
  onL2: (v: boolean) => void;
  onQ: (v: string) => void;
}) {
  const [inputVal, setInputVal] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSearch = (val: string) => {
    setInputVal(val);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onQ(val), 300);
  };

  const Toggle = ({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '4px 10px', borderRadius: '6px', fontSize: '12px',
        fontWeight: 500, cursor: 'pointer', transition: 'all 150ms ease-out',
        background: active ? 'var(--accent-muted)' : 'var(--surface-2)',
        color: active ? 'var(--accent-hover)' : 'var(--text-muted)',
        border: `1px solid ${active ? 'rgba(99,102,241,0.3)' : 'var(--border)'}`,
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: active ? 'var(--accent)' : 'var(--text-faint)',
          transition: 'background 150ms',
        }}
      />
      {label}
    </button>
  );

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '12px 24px', background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        position: 'sticky', top: 0, zIndex: 10,
      }}
    >
      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 2 }}>
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => onStatus(tab.value)}
            style={{
              padding: '5px 12px', borderRadius: '6px', fontSize: '12px',
              fontWeight: 500, cursor: 'pointer', transition: 'all 150ms ease-out',
              background: status === tab.value ? 'var(--surface-2)' : 'transparent',
              color: status === tab.value ? 'var(--text)' : 'var(--text-muted)',
              border: 'none',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ width: 1, height: 20, background: 'var(--border)' }} />

      {/* L1 / L2 toggles */}
      <div style={{ display: 'flex', gap: 6 }}>
        <Toggle active={l1} label="L1 pass" onClick={() => onL1(!l1)} />
        <Toggle active={l2} label="L2 scored" onClick={() => onL2(!l2)} />
      </div>

      {/* Search */}
      <div style={{ marginLeft: 'auto', position: 'relative', minWidth: 220 }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <Input
          placeholder="Search title, company…"
          value={inputVal}
          onChange={e => handleSearch(e.target.value)}
          style={{ paddingLeft: 28, height: '30px', fontSize: '12px' }}
        />
        {inputVal && (
          <button
            onClick={() => { setInputVal(''); onQ(''); }}
            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Job row ──────────────────────────────────────────────────────────────────

function JobRow({
  job, expanded, onToggle, onStatusChange,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (status: JobStatus) => void;
}) {
  const [notes, setNotes] = useState(job.notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleNotes = (val: string) => {
    setNotes(val);
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(async () => {
      setSavingNotes(true);
      await api.jobs.setNotes(job.id, val).catch(() => {});
      setSavingNotes(false);
    }, 800);
  };

  const daysAgo = Math.floor((Date.now() - job.first_seen) / 86400000);
  const daysLabel = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;

  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      {/* Collapsed row */}
      <div
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 1fr 180px 100px 90px 80px',
          alignItems: 'center',
          gap: 16,
          padding: '10px 24px',
          cursor: 'pointer',
          transition: 'background 120ms ease-out',
          background: expanded ? 'var(--surface-2)' : 'transparent',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { if (!expanded) e.currentTarget.style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!expanded) e.currentTarget.style.background = 'transparent'; }}
      >
        {/* Expand icon */}
        <span style={{ color: 'var(--text-faint)', display: 'flex' }}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        {/* Company + Title */}
        <div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text)', lineHeight: 1.3 }}>
            {job.title}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: 2 }}>
            {job.company}
            {job.source_name && (
              <span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>· {job.source_name}</span>
            )}
          </div>
        </div>

        {/* Location */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '12px', color: 'var(--text-muted)' }}>
          {job.remote === 1
            ? <><Globe size={11} /><span>Remote</span></>
            : job.location
            ? <><MapPin size={11} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.location}</span></>
            : <span style={{ color: 'var(--text-faint)' }}>—</span>
          }
        </div>

        {/* Score bar */}
        <div>
          {job.l2_verdict ? (
            <ScoreBar verdict={job.l2_verdict} width={60} />
          ) : job.l1_pass === 1 ? (
            <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>L1 ✓</span>
          ) : (
            <span style={{ fontSize: '11px', color: 'var(--text-faint)' }}>—</span>
          )}
        </div>

        {/* Status */}
        <StatusPill status={job.status as JobStatus} />

        {/* Date */}
        <span style={{ fontSize: '11px', color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
          {daysLabel}
        </span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          style={{
            padding: '0 24px 20px 56px',
            background: 'var(--surface-2)',
            animation: 'fadeIn 150ms ease-out',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24 }}>
            {/* JD text */}
            <div>
              {job.jd_text ? (
                <pre style={{
                  fontFamily: 'var(--mono)', fontSize: '11.5px', lineHeight: 1.65,
                  color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  margin: 0, maxHeight: 320, overflowY: 'auto',
                }}>
                  {job.jd_text.slice(0, 4000)}{job.jd_text.length > 4000 ? '\n…' : ''}
                </pre>
              ) : (
                <p style={{ fontSize: '12px', color: 'var(--text-faint)', fontStyle: 'italic', margin: 0 }}>
                  No job description captured.
                </p>
              )}

              {job.l2_verdict?.reasons && job.l2_verdict.reasons.length > 0 && (
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {job.l2_verdict.reasons.map((r: string, i: number) => (
                    <div key={i} style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: 8 }}>
                      <span style={{ color: 'var(--accent)', flexShrink: 0 }}>·</span>
                      {r}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sidebar actions */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Apply link */}
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: '12px', color: 'var(--accent-hover)',
                  textDecoration: 'none', fontWeight: 500,
                }}
              >
                <ExternalLink size={12} />
                Open posting
              </a>

              {/* Status */}
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</div>
                <StatusPill
                  status={job.status as JobStatus}
                  interactive
                  onChange={(s: JobStatus) => onStatusChange(s)}
                />
              </div>

              {/* Salary if available */}
              {(job.salary_min_usd || job.l2_verdict?.salary_min_usd) && (
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Salary</div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                    ${((job.salary_min_usd ?? job.l2_verdict?.salary_min_usd) ?? 0).toLocaleString()}
                    {job.salary_max_usd ? `–$${job.salary_max_usd.toLocaleString()}` : '+'}
                  </span>
                </div>
              )}

              {/* Notes */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between' }}>
                  <span>Notes</span>
                  {savingNotes && <span style={{ color: 'var(--accent)', textTransform: 'none', letterSpacing: 0 }}>saving…</span>}
                </div>
                <Textarea
                  value={notes}
                  onChange={e => handleNotes(e.target.value)}
                  placeholder="Add notes…"
                  rows={4}
                />
              </div>

              {/* Meta */}
              <div style={{ fontSize: '11px', color: 'var(--text-faint)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span>First seen: {new Date(job.first_seen).toLocaleDateString()}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '10px' }}>{job.url.slice(0, 50)}…</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 24px', gap: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: '10px', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <SlidersHorizontal size={18} style={{ color: 'var(--text-faint)' }} />
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>
        {hasFilters ? 'No jobs match these filters' : 'No jobs yet — run a scan to get started'}
      </p>
      {hasFilters && (
        <p style={{ color: 'var(--text-faint)', fontSize: '12px', margin: 0 }}>
          Try clearing filters or running a new scan
        </p>
      )}
    </div>
  );
}

// ─── Column headers ───────────────────────────────────────────────────────────

function TableHeader() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 1fr 180px 100px 90px 80px',
        gap: 16, padding: '8px 24px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {['', 'Position', 'Location', 'Score', 'Status', 'Seen'].map((h, i) => (
        <span
          key={i}
          style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
        >
          {h}
        </span>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Jobs() {
  const [params, setParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const status = params.get('status') ?? '';
  const l1 = params.get('l1') === '1';
  const l2 = params.get('l2') === '1';
  const q = params.get('q') ?? '';

  const setParam = (key: string, val: string) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (val) next.set(key, val);
      else next.delete(key);
      return next;
    });
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.jobs.list({
        status: status || undefined,
        l1: l1 ? '1' : undefined,
        l2: l2 ? '1' : undefined,
        q: q || undefined,
        limit: 200,
      });
      setJobs(res.jobs);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [status, l1, l2, q]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (job: Job, newStatus: JobStatus) => {
    // Optimistic update
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus } : j));
    await api.jobs.setStatus(job.id, newStatus).catch(() => load());
  };

  const hasFilters = !!(status || l1 || l2 || q);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Page header */}
      <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.02em' }}>
          Jobs
        </h1>
        {!loading && (
          <span style={{ fontSize: '13px', color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
            {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
          </span>
        )}
      </div>

      <FilterBar
        status={status} l1={l1} l2={l2} q={q}
        onStatus={v => setParam('status', v)}
        onL1={v => setParam('l1', v ? '1' : '')}
        onL2={v => setParam('l2', v ? '1' : '')}
        onQ={v => setParam('q', v)}
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <Spinner size={20} />
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState hasFilters={hasFilters} />
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <TableHeader />
          {jobs.map(job => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expandedId === job.id}
              onToggle={() => setExpandedId(prev => prev === job.id ? null : job.id)}
              onStatusChange={status => handleStatusChange(job, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
