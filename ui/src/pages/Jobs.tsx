import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ExternalLink, Search, MapPin, Globe, X,
} from 'lucide-react';
import { api, type Job, type JobStatus } from '@/lib/api';
import { Input, Textarea, Spinner } from '@/components/ui';
import { StatusPill } from '@/components/StatusPill';
import { ScoreBar, ScoreRing } from '@/components/ScoreBar';
import { EmptyLantern } from '@/components/brand';

const PAGE_LIMIT = 200;
const GRID = 'minmax(0,1fr) 160px 116px 110px 64px';

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'New', value: 'new' },
  { label: 'Shortlist', value: 'shortlist' },
  { label: 'Applied', value: 'applied' },
  { label: 'Interview', value: 'interview' },
  { label: 'Offer', value: 'offer' },
];

function FilterBar({
  status, l1, l2, q, onStatus, onL1, onL2, onQ,
}: {
  status: string; l1: boolean; l2: boolean; q: string;
  onStatus: (v: string) => void; onL1: (v: boolean) => void;
  onL2: (v: boolean) => void; onQ: (v: string) => void;
}) {
  const [inputVal, setInputVal] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { setInputVal(q); }, [q]);

  const handleSearch = (val: string) => {
    setInputVal(val);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onQ(val), 300);
  };

  const Toggle = ({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 11px', borderRadius: 'var(--radius-md)', fontSize: '12.5px',
        fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
        transition: 'all 150ms cubic-bezier(0.22,1,0.36,1)',
        background: active ? 'var(--accent-muted)' : 'transparent',
        color: active ? 'var(--accent-text)' : 'var(--text-muted)',
        border: `1px solid ${active ? 'transparent' : 'var(--border)'}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? 'var(--accent)' : 'var(--text-faint)' }} />
      {label}
    </button>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', flexWrap: 'wrap', padding: '12px 0', borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', gap: 2 }}>
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => onStatus(tab.value)}
            style={{
              padding: '5px 12px', borderRadius: 'var(--radius-md)', fontSize: '12.5px',
              fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
              transition: 'all 150ms ease',
              background: status === tab.value ? 'var(--surface-2)' : 'transparent',
              color: status === tab.value ? 'var(--text)' : 'var(--text-muted)',
              border: 'none',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ width: 1, height: 18, background: 'var(--border)' }} />

      <div style={{ display: 'flex', gap: 6 }}>
        <Toggle active={l1} label="L1 pass" onClick={() => onL1(!l1)} />
        <Toggle active={l2} label="L2 scored" onClick={() => onL2(!l2)} />
      </div>

      <div style={{ marginLeft: 'auto', position: 'relative', minWidth: 230 }}>
        <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none' }} />
        <Input
          aria-label="Filter jobs by title or company"
          placeholder="Filter title, company…"
          value={inputVal}
          onChange={e => handleSearch(e.target.value)}
          style={{ paddingLeft: 32, height: 34, fontSize: '13px' }}
        />
        {inputVal && (
          <button aria-label="Clear filter" onClick={() => { setInputVal(''); onQ(''); }} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 0, display: 'flex' }}>
            <X size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, selected, index, onSelect }: { job: Job; selected: boolean; index: number; onSelect: () => void }) {
  const daysAgo = Math.floor((Date.now() - job.first_seen) / 86400000);
  const seen = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d' : `${daysAgo}d`;

  return (
    <div
      onClick={onSelect}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      role="button"
      tabIndex={0}
      aria-label={`${job.title} at ${job.company}`}
      className={selected ? 'job-row job-row-selected jobs-grid' : 'job-row jobs-grid'}
      style={{
        display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 16,
        padding: '11px 14px', cursor: 'pointer', borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--accent-muted)' : 'transparent',
        transition: 'background 120ms ease',
        animation: 'rise 360ms cubic-bezier(0.22,1,0.36,1) both',
        animationDelay: `${Math.min(index * 14, 200)}ms`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '13.5px', fontWeight: 550, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.title}
        </div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.company}
          {job.source_name && <span style={{ color: 'var(--text-faint)' }}> · {job.source_name}</span>}
        </div>
      </div>

      <div className="col-location" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: 'var(--text-muted)', minWidth: 0 }}>
        {job.remote === 1
          ? <><Globe size={12} style={{ flexShrink: 0 }} /><span>Remote</span></>
          : job.location
          ? <><MapPin size={12} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.location}</span></>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>}
      </div>

      <div>
        {job.l2_verdict ? <ScoreBar verdict={job.l2_verdict} width={52} />
          : job.l1_pass === 1 ? <span style={{ fontSize: '11.5px', color: 'var(--text-faint)' }}>L1 passed</span>
          : <span style={{ fontSize: '11.5px', color: 'var(--text-faint)' }}>—</span>}
      </div>

      <StatusPill status={job.status as JobStatus} />

      <span className="col-seen tnum" style={{ fontSize: '11.5px', color: 'var(--text-faint)', textAlign: 'right' }}>{seen}</span>
    </div>
  );
}

function DetailPanel({ job, onClose, onStatusChange }: {
  job: Job; onClose: () => void; onStatusChange: (s: JobStatus) => void;
}) {
  const [notes, setNotes] = useState(job.notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { setNotes(job.notes ?? ''); }, [job.id, job.notes]);

  const handleNotes = (val: string) => {
    setNotes(val);
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(async () => {
      setSavingNotes(true);
      await api.jobs.setNotes(job.id, val).catch(() => {});
      setSavingNotes(false);
    }, 800);
  };

  const v = job.l2_verdict;
  const salary = job.salary_min_usd ?? v?.salary_min_usd;

  const Label = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 7 }}>{children}</div>
  );

  return (
    <aside className="detail-panel" style={{
      position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(460px, 92vw)',
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
      boxShadow: 'var(--shadow-md)', zIndex: 40, display: 'flex', flexDirection: 'column',
      animation: 'panel-in 260ms cubic-bezier(0.22,1,0.36,1)', overflow: 'hidden',
    }}>
      <style>{`@keyframes panel-in{from{transform:translateX(24px);opacity:0;}to{transform:translateX(0);opacity:1;}}`}</style>

      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 14, padding: '22px 22px 18px', borderBottom: '1px solid var(--border)' }}>
        {/* soft glow behind the header — the panel's own little lantern light */}
        <div aria-hidden style={{ position: 'absolute', top: -90, right: -40, width: 240, height: 200, pointerEvents: 'none', background: 'radial-gradient(50% 50% at 50% 50%, color-mix(in oklch, var(--accent) 18%, transparent), transparent 70%)', animation: 'breathe 8s ease-in-out infinite' }} />
        {v && <div style={{ position: 'relative', zIndex: 1 }}><ScoreRing score={v.score} /></div>}
        <div style={{ flex: 1, minWidth: 0, position: 'relative', zIndex: 1 }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 580, color: 'var(--text)', lineHeight: 1.22 }}>{job.title}</h2>
          <div style={{ fontSize: '13.5px', color: 'var(--text-muted)', marginTop: 4 }}>
            {job.company}{job.source_name && <span style={{ color: 'var(--text-faint)' }}> · {job.source_name}</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            <StatusPill status={job.status as JobStatus} interactive onChange={onStatusChange} />
          </div>
        </div>
        <button onClick={onClose} aria-label="Close details" style={{ position: 'relative', zIndex: 1, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 8, margin: -4, borderRadius: 'var(--radius-sm)', display: 'flex', flexShrink: 0 }}>
          <X size={18} />
        </button>
      </div>

      <div className="panel-stagger" style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-lg)' }}>
          <div>
            <Label>Location</Label>
            <div style={{ fontSize: '13px', color: 'var(--text)' }}>
              {job.remote === 1 ? 'Remote' : job.location || '—'}
            </div>
          </div>
          {salary != null && (
            <div>
              <Label>Salary</Label>
              <div className="tnum" style={{ fontSize: '13px', color: 'var(--text)' }}>
                ${salary.toLocaleString()}{job.salary_max_usd ? `–$${job.salary_max_usd.toLocaleString()}` : '+'}
              </div>
            </div>
          )}
          {v?.seniority && (
            <div>
              <Label>Seniority</Label>
              <div style={{ fontSize: '13px', color: 'var(--text)', textTransform: 'capitalize' }}>{v.seniority}</div>
            </div>
          )}
        </div>

        {v?.reasons && v.reasons.length > 0 && (
          <div>
            <Label>Why it matched</Label>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {v.reasons.map((r, i) => (
                <li key={i} style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'flex', gap: 8, lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--accent-text)', flexShrink: 0 }}>·</span>{r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {v?.stack_match && v.stack_match.length > 0 && (
          <div>
            <Label>Stack match</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {v.stack_match.map(s => (
                <span key={s} style={{ fontSize: '11.5px', padding: '2px 8px', background: 'var(--accent-muted)', color: 'var(--accent-text)', borderRadius: 'var(--radius-sm)' }}>{s}</span>
              ))}
            </div>
          </div>
        )}

        <div>
          <Label>Notes {savingNotes && <span style={{ color: 'var(--accent-text)', textTransform: 'none', letterSpacing: 0 }}>· saving</span>}</Label>
          <Textarea value={notes} onChange={e => handleNotes(e.target.value)} placeholder="Add notes…" rows={4} style={{ fontFamily: 'var(--font-ui)', fontSize: '13px' }} />
        </div>

        <div>
          <Label>Description</Label>
          {job.jd_text ? (
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', lineHeight: 1.65, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
              {job.jd_text.slice(0, 4000)}{job.jd_text.length > 4000 ? '\n…' : ''}
            </pre>
          ) : (
            <p style={{ fontSize: '12.5px', color: 'var(--text-faint)', fontStyle: 'italic', margin: 0 }}>No description captured.</p>
          )}
        </div>

        <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
          First seen {new Date(job.first_seen).toLocaleDateString()}
        </div>
      </div>

      <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)' }}>
        <a href={job.url} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '13.5px', color: 'var(--accent-text)', textDecoration: 'none', fontWeight: 550 }}>
          <ExternalLink size={14} /> Open posting
        </a>
      </div>
    </aside>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '72px 24px', gap: 6, textAlign: 'center', animation: 'rise 500ms cubic-bezier(0.22,1,0.36,1) both' }}>
      <EmptyLantern size={120} dim={!hasFilters} />
      <p style={{ color: 'var(--text)', fontSize: '15px', margin: 0, fontFamily: 'var(--font-serif)' }}>
        {hasFilters ? <>Nothing <em style={{ color: 'var(--accent-2)' }}>matches</em></> : <>No matches <em style={{ color: 'var(--accent-2)' }}>yet</em></>}
      </p>
      <p style={{ color: 'var(--text-faint)', fontSize: '13px', margin: 0, maxWidth: '38ch' }}>
        {hasFilters ? 'Try clearing filters or running a new search.' : 'Run a search and Lantern will light up matching jobs.'}
      </p>
    </div>
  );
}

export default function Jobs() {
  const [params, setParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const status = params.get('status') ?? '';
  const l1 = params.get('l1') === '1';
  const l2 = params.get('l2') === '1';
  const q = params.get('q') ?? '';

  const setParam = (key: string, val: string) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (val) next.set(key, val); else next.delete(key);
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
        limit: PAGE_LIMIT,
      });
      setJobs(res.jobs);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [status, l1, l2, q]);

  useEffect(() => { load(); }, [load]);

  const handleStatusChange = async (job: Job, newStatus: JobStatus) => {
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: newStatus } : j));
    await api.jobs.setStatus(job.id, newStatus).catch(() => load());
  };

  const selected = jobs.find(j => j.id === selectedId) ?? null;

  // Keyboard triage: j/k or arrows to move + open, Esc to close. Bind once and
  // read live state via refs to avoid re-attaching the listener on every move.
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const selRef = useRef(selectedId); selRef.current = selectedId;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') { setSelectedId(null); return; }
      const list = jobsRef.current;
      if (list.length === 0) return;
      const cur = selRef.current;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = cur ? list.findIndex(j => j.id === cur) : -1;
        setSelectedId(list[Math.min(idx + 1, list.length - 1)].id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = cur ? list.findIndex(j => j.id === cur) : list.length;
        setSelectedId(list[Math.max(idx - 1, 0)].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hasFilters = !!(status || l1 || l2 || q);

  return (
    <div className="jobs-main" style={{ padding: 'var(--space-xl)', maxWidth: 1100, margin: '0 auto', marginRight: selected ? 'min(460px, 92vw)' : 'auto', transition: 'margin-right 220ms cubic-bezier(0.22,1,0.36,1)' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 'var(--space-xs)' }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 580, color: 'var(--text)' }}>Jobs</h1>
        {!loading && (
          <span className="tnum" style={{ fontSize: '13.5px', color: 'var(--text-faint)' }}>
            {total.toLocaleString()} {total === 1 ? 'result' : 'results'}
            {total > PAGE_LIMIT && ` · showing ${PAGE_LIMIT}`}
          </span>
        )}
      </header>

      <FilterBar
        status={status} l1={l1} l2={l2} q={q}
        onStatus={v => setParam('status', v)}
        onL1={v => setParam('l1', v ? '1' : '')}
        onL2={v => setParam('l2', v ? '1' : '')}
        onQ={v => setParam('q', v)}
      />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '70px 0' }}><Spinner size={20} /></div>
      ) : jobs.length === 0 ? (
        <EmptyState hasFilters={hasFilters} />
      ) : (
        <>
          <div className="jobs-grid" style={{ display: 'grid', gridTemplateColumns: GRID, gap: 16, padding: '10px 14px 8px' }}>
            {([
              ['Position', ''], ['Location', 'col-location'], ['Score', ''], ['Status', ''], ['Seen', 'col-seen'],
            ] as const).map(([h, cls], i) => (
              <span key={h} className={cls} style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: i === 4 ? 'right' : 'left' }}>{h}</span>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {jobs.map((job, i) => (
              <JobRow key={job.id} job={job} index={i} selected={selectedId === job.id} onSelect={() => setSelectedId(job.id)} />
            ))}
          </div>
          <style>{`.job-row:not(.job-row-selected):hover{background:var(--surface-2);}`}</style>
        </>
      )}

      {selected && (
        <DetailPanel
          job={selected}
          onClose={() => setSelectedId(null)}
          onStatusChange={s => handleStatusChange(selected, s)}
        />
      )}
    </div>
  );
}
