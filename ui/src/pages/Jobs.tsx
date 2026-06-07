import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ExternalLink, Search, MapPin, Globe, X, Banknote, GaugeCircle, SlidersHorizontal, Check,
} from 'lucide-react';
import { api, type Job, type JobStatus } from '@/lib/api';
import { Textarea, Spinner } from '@/components/ui';
import { StatusPill } from '@/components/StatusPill';
import { scoreColor } from '@/components/score';
import { EmptyLantern } from '@/components/brand';

function fitLabel(score: number): string {
  return score >= 0.8 ? 'Strong match' : score >= 0.6 ? 'Good match' : score >= 0.4 ? 'Fair match' : 'Weak match';
}

// Bold, integrated fit readout for the detail panel — a score-colored number +
// qualitative label over a position bar. Replaces the floating ring (which read
// as a different metaphor from the horizontal score bars used everywhere else).
function FitMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = scoreColor(score);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 9 }}>
        <span className="tnum" style={{ fontFamily: 'var(--font-mono)', fontSize: '34px', fontWeight: 600, color, lineHeight: 1, letterSpacing: '-0.02em' }}>
          {pct}<span style={{ fontSize: '16px', marginLeft: 1 }}>%</span>
        </span>
        <span style={{ fontSize: '10.5px', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>fit</span>
        <span style={{ marginLeft: 'auto', fontSize: '12.5px', color, fontWeight: 600 }}>{fitLabel(score)}</span>
      </div>
      <div style={{ position: 'relative', height: 6, borderRadius: 'var(--radius-full)', background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: `${pct}%`, background: color, borderRadius: 'var(--radius-full)', transition: 'width 600ms cubic-bezier(0.22,1,0.36,1)' }} />
      </div>
    </div>
  );
}

const PAGE_LIMIT = 200;
// The index grid: fit numeral leads, then role, location, status, age. Fit and
// age use tabular figures; the role column flexes.
const GRID = '46px minmax(0,1fr) 184px 124px 46px';

const STATUS_TABS = [
  { label: 'All', value: '' },
  { label: 'New', value: 'new' },
  { label: 'Shortlist', value: 'shortlist' },
  { label: 'Applied', value: 'applied' },
  { label: 'Interview', value: 'interview' },
  { label: 'Offer', value: 'offer' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Hidden', value: 'hidden' },
];

// Source types for the roster filter, with display labels (the internal ids
// like "remoteok" aren't how the boards are branded).
const SOURCE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'greenhouse', label: 'Greenhouse' },
  { value: 'ashby', label: 'Ashby' },
  { value: 'lever', label: 'Lever' },
  { value: 'recruitee', label: 'Recruitee' },
  { value: 'smartrecruiters', label: 'SmartRecruiters' },
  { value: 'workable', label: 'Workable' },
  { value: 'personio', label: 'Personio' },
  { value: 'remoteok', label: 'RemoteOK' },
  { value: 'arbeitnow', label: 'Arbeitnow' },
  { value: 'himalayas', label: 'Himalayas' },
];

// Understated underline search — the masthead's quiet right-hand affordance.
function SearchField({ q, onQ }: { q: string; onQ: (v: string) => void }) {
  const [val, setVal] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { setVal(q); }, [q]);
  const handle = (v: string) => {
    setVal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onQ(v), 250);
  };
  return (
    <div className="job-search">
      <Search size={15} className="job-search-icon" />
      <input
        aria-label="Filter jobs by title or company"
        placeholder="Filter roles"
        value={val}
        onChange={e => handle(e.target.value)}
      />
      {val && (
        <button aria-label="Clear filter" onClick={() => { setVal(''); onQ(''); }}><X size={13} /></button>
      )}
      <style>{`
        .job-search { position: relative; display: flex; align-items: center; width: clamp(190px, 22vw, 250px); }
        .job-search-icon { position: absolute; left: 12px; color: var(--text-faint); pointer-events: none; transition: color 160ms ease; }
        .job-search input {
          width: 100%; height: 38px; padding: 0 32px 0 34px; font-family: var(--font-ui); font-size: 13.5px;
          background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-full);
          color: var(--text); outline: none; transition: border-color 160ms ease, box-shadow 160ms ease;
        }
        .job-search input::placeholder { color: var(--text-faint); }
        .job-search:focus-within .job-search-icon { color: var(--accent-text); }
        .job-search input:focus { border-color: color-mix(in oklch, var(--accent) 55%, var(--border)); box-shadow: 0 10px 30px -14px color-mix(in oklch, var(--accent) 60%, transparent); }
        .job-search button { position: absolute; right: 11px; display: flex; padding: 0; background: none; border: none; cursor: pointer; color: var(--text-faint); }
        .job-search button:hover { color: var(--text); }
      `}</style>
    </div>
  );
}

// Primary triage axis: the status funnel as quiet editorial section-nav, with an
// amber tick under the active one. No pills.
function StatusNav({ status, onStatus }: { status: string; onStatus: (v: string) => void }) {
  return (
    <nav className="status-nav" aria-label="Filter by status">
      {STATUS_TABS.map(tab => (
        <button key={tab.value} onClick={() => onStatus(tab.value)} className={status === tab.value ? 'snav active' : 'snav'}>
          {tab.label}
        </button>
      ))}
      <style>{`
        .status-nav { display: flex; flex-wrap: wrap; align-items: center; }
        .snav { position: relative; padding: 9px 0; margin-right: 20px; background: none; border: none; cursor: pointer;
          font-family: var(--font-ui); font-size: 13px; color: var(--text-faint); transition: color 160ms ease; }
        .snav:hover { color: var(--text-muted); }
        .snav.active { color: var(--text); font-weight: 550; }
        .snav.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: var(--accent); }
      `}</style>
    </nav>
  );
}

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="switch-row" role="switch" aria-checked={checked}>
      <span style={{ fontSize: '13px', color: checked ? 'var(--text)' : 'var(--text-muted)' }}>{label}</span>
      <span aria-hidden style={{
        width: 30, height: 18, borderRadius: 'var(--radius-full)', flexShrink: 0, position: 'relative',
        background: checked ? 'var(--accent)' : 'var(--border)', transition: 'background 180ms ease',
      }}>
        <span style={{
          position: 'absolute', top: 2, left: checked ? 14 : 2, width: 14, height: 14, borderRadius: '50%',
          background: checked ? 'var(--accent-ink)' : 'var(--surface)', transition: 'left 180ms cubic-bezier(0.22,1,0.36,1)',
        }} />
      </span>
    </button>
  );
}

// All secondary filters collapse behind one control (progressive disclosure), so
// the always-visible bar stays calm. Badge shows how many are active.
function RefineControl({
  fit, remote, l1, l2, sourceTypes, onFit, onRemote, onL1, onL2, onToggleSource, onClearAll,
}: {
  fit: boolean; remote: boolean; l1: boolean; l2: boolean; sourceTypes: string[];
  onFit: (v: boolean) => void; onRemote: (v: boolean) => void; onL1: (v: boolean) => void;
  onL2: (v: boolean) => void; onToggleSource: (v: string) => void; onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = [fit, remote, l1, l2].filter(Boolean).length + sourceTypes.length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} className="refine-btn" aria-expanded={open} data-active={count > 0}>
        <SlidersHorizontal size={14} />
        Refine
        {count > 0 && <span className="refine-badge">{count}</span>}
      </button>

      {open && (
        <div className="refine-pop" role="dialog" aria-label="Refine results">
          <div className="refine-sec-label">Match</div>
          <SwitchRow label="Fit only" checked={fit} onChange={onFit} />
          <SwitchRow label="L1 passed" checked={l1} onChange={onL1} />
          <SwitchRow label="L2 scored" checked={l2} onChange={onL2} />
          <div className="refine-divider" />
          <div className="refine-sec-label">Location</div>
          <SwitchRow label="Remote only" checked={remote} onChange={onRemote} />
          <div className="refine-divider" />
          <div className="refine-sec-label">Source <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-faint)', fontWeight: 400 }}>· choose any</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {SOURCE_TYPE_OPTIONS.map(o => {
              const active = o.value === '' ? sourceTypes.length === 0 : sourceTypes.includes(o.value);
              return (
                <button key={o.value} onClick={() => onToggleSource(o.value)} className={active ? 'src-chip active' : 'src-chip'}>
                  {active && o.value !== '' && <Check size={11} style={{ marginRight: 3, verticalAlign: '-1px' }} />}
                  {o.label}
                </button>
              );
            })}
          </div>
          {count > 0 && (
            <button onClick={onClearAll} className="refine-clear">Clear all filters</button>
          )}
        </div>
      )}

      <style>{`
        .refine-btn { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: var(--radius-md);
          background: transparent; border: 1px solid var(--border); cursor: pointer; font-family: var(--font-ui);
          font-size: 13px; font-weight: 500; color: var(--text-muted); transition: all 160ms ease; }
        .refine-btn:hover { color: var(--text); border-color: var(--border-strong, var(--text-faint)); }
        .refine-btn[data-active="true"] { color: var(--accent-text); border-color: color-mix(in oklch, var(--accent) 40%, transparent); background: var(--accent-muted); }
        .refine-badge { min-width: 17px; height: 17px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; border-radius: var(--radius-full);
          background: var(--accent); color: var(--accent-ink); }
        .refine-pop { position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; width: 264px; padding: 14px;
          background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-md);
          animation: fadeIn 140ms cubic-bezier(0.22,1,0.36,1); }
        .refine-sec-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-faint); margin-bottom: 4px; }
        .refine-divider { height: 1px; background: var(--border-subtle); margin: 12px 0; }
        .switch-row { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 7px 0;
          background: none; border: none; cursor: pointer; font-family: inherit; }
        .src-chip { padding: 4px 9px; border-radius: var(--radius-full); border: 1px solid var(--border); background: transparent;
          cursor: pointer; font-family: var(--font-ui); font-size: 12px; color: var(--text-muted); transition: all 140ms ease; }
        .src-chip:hover { color: var(--text); }
        .src-chip.active { background: var(--accent-muted); border-color: transparent; color: var(--accent-text); font-weight: 550; }
        .refine-clear { margin-top: 14px; width: 100%; padding: 8px; background: none; border: 1px solid var(--border-subtle);
          border-radius: var(--radius-md); cursor: pointer; font-family: var(--font-ui); font-size: 12.5px; color: var(--text-muted); }
        .refine-clear:hover { color: var(--danger); border-color: color-mix(in oklch, var(--danger) 30%, transparent); }
      `}</style>
    </div>
  );
}

function JobRow({ job, selected, index, onSelect }: { job: Job; selected: boolean; index: number; onSelect: () => void }) {
  const daysAgo = Math.floor((Date.now() - job.first_seen) / 86400000);
  const seen = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d' : `${daysAgo}d`;
  const v = job.l2_verdict;

  return (
    <div
      onClick={onSelect}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      role="button"
      tabIndex={0}
      aria-label={`${job.title} at ${job.company}`}
      className={selected ? 'job-row job-row-selected jobs-grid' : 'job-row jobs-grid'}
      style={{
        display: 'grid', gridTemplateColumns: GRID, alignItems: 'baseline', columnGap: 18,
        padding: '15px 14px', cursor: 'pointer',
        borderBottom: '1px solid var(--border-subtle)',
        background: selected ? 'var(--accent-muted)' : 'transparent',
        transition: 'background 140ms ease',
        animation: 'rise 340ms cubic-bezier(0.22,1,0.36,1) both',
        animationDelay: `${Math.min(index * 12, 180)}ms`,
      }}
    >
      {/* Fit numeral — the ranking spine; warm score-ramp color carries the signal. */}
      <div style={{ alignSelf: 'center' }}>
        {v
          ? <span className="tnum" style={{ fontFamily: 'var(--font-mono)', fontSize: '19px', fontWeight: 600, color: scoreColor(v.score), letterSpacing: '-0.02em', lineHeight: 1 }}>{Math.round(v.score * 100)}</span>
          : <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>{job.l1_pass === 1 ? 'L1' : '—'}</span>}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14.5px', fontWeight: 560, color: 'var(--text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.title}
        </div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.company}
          {job.source_name && <span style={{ color: 'var(--text-faint)' }}> · {job.source_name}</span>}
        </div>
      </div>

      <div className="col-location" style={{ alignSelf: 'center', display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', color: 'var(--text-muted)', minWidth: 0 }}>
        {job.remote === 1
          ? <><Globe size={12} style={{ flexShrink: 0 }} /><span>Remote</span></>
          : job.location
          ? <><MapPin size={12} style={{ flexShrink: 0, color: 'var(--text-faint)' }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.location}</span></>
          : <span style={{ color: 'var(--text-faint)' }}>—</span>}
      </div>

      <div style={{ alignSelf: 'center' }}>
        <StatusPill status={job.status as JobStatus} />
      </div>

      <span className="col-seen tnum" style={{ alignSelf: 'center', fontSize: '11.5px', color: 'var(--text-faint)', textAlign: 'right' }}>{seen}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: '10.5px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 9 }}>
      {children}
    </div>
  );
}

// One cell of the inline meta strip (icon + label stacked over value).
function MetaCell({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '0 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-faint)', marginBottom: 4 }}>
        {icon}
        <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
      </div>
      <div style={{ fontSize: '13.5px', color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
    </div>
  );
}

function DetailPanel({ job, onClose, onStatusChange }: {
  job: Job; onClose: () => void; onStatusChange: (s: JobStatus) => void;
}) {
  const [notes, setNotes] = useState(job.notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [showFullJd, setShowFullJd] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => { setNotes(job.notes ?? ''); setShowFullJd(false); }, [job.id, job.notes]);

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
  const locationValue = job.remote === 1 ? 'Remote' : job.location || '—';
  // Drop empty/whitespace reasons so a verdict with no real reason text doesn't
  // render an empty "why it matched" section.
  const reasons = (v?.reasons ?? []).filter(r => r.trim().length > 0);

  // Build the meta strip cells conditionally so empty fields don't leave gaps.
  const cells: { icon: React.ReactNode; label: string; value: React.ReactNode }[] = [
    { icon: job.remote === 1 ? <Globe size={12} /> : <MapPin size={12} />, label: 'Location', value: locationValue },
  ];
  if (salary != null) {
    cells.push({
      icon: <Banknote size={12} />, label: 'Salary',
      value: <span className="tnum">${salary.toLocaleString()}{job.salary_max_usd ? `–$${job.salary_max_usd.toLocaleString()}` : '+'}</span>,
    });
  }
  if (v?.seniority) {
    cells.push({ icon: <GaugeCircle size={12} />, label: 'Seniority', value: <span style={{ textTransform: 'capitalize' }}>{v.seniority}</span> });
  }

  const jdText = job.jd_text ?? '';
  const jdLimit = 1400;
  const jdTruncated = jdText.length > jdLimit;
  const jdShown = showFullJd ? jdText : jdText.slice(0, jdLimit);

  return (
    <aside className="detail-panel" style={{
      position: 'fixed', top: 0, right: 0, height: '100vh', width: 'min(480px, 94vw)',
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
      boxShadow: 'var(--shadow-md)', zIndex: 40, display: 'flex', flexDirection: 'column',
      animation: 'panel-in 260ms cubic-bezier(0.22,1,0.36,1)', overflow: 'hidden',
    }}>
      <style>{`@keyframes panel-in{from{transform:translateX(24px);opacity:0;}to{transform:translateX(0);opacity:1;}}`}</style>

      {/* Hero header — the fit score is the headline; lantern glow tinted warm.
          No overflow:hidden here (it would clip the status dropdown); the aside's
          own overflow:hidden contains the glow. zIndex keeps the header — and the
          dropdown it hosts — above the scrolling body below. */}
      <div style={{ position: 'relative', zIndex: 2, padding: '24px 22px 20px', borderBottom: '1px solid var(--border)' }}>
        <div aria-hidden style={{ position: 'absolute', top: -120, right: -60, width: 300, height: 240, pointerEvents: 'none', background: 'radial-gradient(50% 50% at 50% 50%, color-mix(in oklch, var(--accent) 22%, transparent), transparent 70%)', animation: 'breathe 8s ease-in-out infinite' }} />
        <button onClick={onClose} aria-label="Close details" style={{ position: 'absolute', top: 16, right: 16, zIndex: 2, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', cursor: 'pointer', color: 'var(--text-muted)', padding: 7, borderRadius: 'var(--radius-md)', display: 'flex' }}>
          <X size={16} />
        </button>

        <div style={{ position: 'relative', zIndex: 1, paddingRight: 36 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: '23px', fontWeight: 580, color: 'var(--text)', lineHeight: 1.16, letterSpacing: '-0.01em' }}>{job.title}</h2>
          <div style={{ fontSize: '13.5px', color: 'var(--text-muted)', marginTop: 5 }}>
            <span style={{ fontWeight: 500, color: 'var(--text)' }}>{job.company}</span>
            {job.source_name && <span style={{ color: 'var(--text-faint)' }}> · {job.source_name}</span>}
          </div>
        </div>

        <div style={{ position: 'relative', zIndex: 1, marginTop: 18 }}>
          {v
            ? <FitMeter score={v.score} />
            : <span style={{ fontSize: '12.5px', color: 'var(--text-faint)' }}>{job.l1_pass === 1 ? 'Passed L1 — not yet L2-scored' : 'Not scored'}</span>}
        </div>

        <div style={{ position: 'relative', zIndex: 1, marginTop: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusPill status={job.status as JobStatus} interactive onChange={onStatusChange} />
          {v?.remote_confirmed && (
            <span style={{ fontSize: '11.5px', fontWeight: 500, color: 'var(--tone-blue)', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 'var(--radius-full)', background: 'color-mix(in oklch, var(--tone-blue) 14%, transparent)' }}>
              <Globe size={11} /> Remote confirmed
            </span>
          )}
        </div>
      </div>

      <div className="panel-stagger" style={{ position: 'relative', zIndex: 1, flex: 1, overflowY: 'auto', padding: '20px 22px 24px', display: 'flex', flexDirection: 'column', gap: 'var(--space-xl)' }}>
        {/* Meta strip — inline cells divided by hairlines, one scannable row. */}
        <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '12px 0', background: 'var(--surface-2)' }}>
          {cells.map((cell, i) => (
            <div key={cell.label} style={{ display: 'contents' }}>
              {i > 0 && <div style={{ width: 1, background: 'var(--border-subtle)', alignSelf: 'stretch' }} />}
              <MetaCell icon={cell.icon} label={cell.label} value={cell.value} />
            </div>
          ))}
        </div>

        {/* Why it matched — integrated editorial list (mono index + hairlines),
            deliberately not a colored callout card. */}
        {reasons.length > 0 && (
          <div>
            <SectionLabel>Why it matched</SectionLabel>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {reasons.map((r, i) => (
                <li key={i} style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: i > 0 ? '1px solid var(--border-subtle)' : 'none' }}>
                  <span className="tnum" style={{ color: 'var(--accent-text)', fontFamily: 'var(--font-mono)', fontSize: '12px', flexShrink: 0, marginTop: 2 }}>{String(i + 1).padStart(2, '0')}</span>
                  <span style={{ fontSize: '13.5px', color: 'var(--text)', lineHeight: 1.55 }}>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {v?.stack_match && v.stack_match.length > 0 && (
          <div>
            <SectionLabel>Stack match</SectionLabel>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {v.stack_match.map(s => (
                <span key={s} style={{ fontSize: '12px', fontWeight: 500, padding: '4px 10px', background: 'color-mix(in oklch, var(--accent) 12%, transparent)', color: 'var(--accent-text)', borderRadius: 'var(--radius-full)', border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)' }}>{s}</span>
              ))}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>Notes {savingNotes && <span style={{ color: 'var(--accent-text)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>· saving</span>}</SectionLabel>
          <Textarea value={notes} onChange={e => handleNotes(e.target.value)} placeholder="Add notes…" rows={3} style={{ fontFamily: 'var(--font-ui)', fontSize: '13px' }} />
        </div>

        <div>
          <SectionLabel>Description</SectionLabel>
          {jdText ? (
            <>
              <div style={{ position: 'relative' }}>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', lineHeight: 1.7, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {jdShown}{jdTruncated && !showFullJd ? '…' : ''}
                </div>
                {jdTruncated && !showFullJd && (
                  <div aria-hidden style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: 'linear-gradient(transparent, var(--surface))', pointerEvents: 'none' }} />
                )}
              </div>
              {jdTruncated && (
                <button onClick={() => setShowFullJd(s => !s)} style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 550 }}>
                  {showFullJd ? 'Show less' : 'Show full description'}
                </button>
              )}
            </>
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
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 42, borderRadius: 'var(--radius-lg)', background: 'var(--accent)', color: 'var(--accent-ink)', textDecoration: 'none', fontSize: '14px', fontWeight: 600 }}>
          <ExternalLink size={15} /> Open posting
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
  const fit = params.get('fit') === '1';
  const remote = params.get('remote') === '1';
  const sourceTypeRaw = params.get('source_type') ?? '';
  const sourceTypes = sourceTypeRaw.split(',').filter(Boolean);
  const q = params.get('q') ?? '';

  // Apply several URL-param changes in ONE setParams call. Calling setParams
  // multiple times in a tick doesn't accumulate (each functional update reads the
  // same snapshot), so batched edits like "clear all filters" must mutate once.
  const mutate = useCallback((fn: (p: URLSearchParams) => void) => {
    setParams(prev => { const next = new URLSearchParams(prev); fn(next); return next; });
  }, [setParams]);

  const setParam = (key: string, val: string) => mutate(p => { if (val) p.set(key, val); else p.delete(key); });

  // Source filter is multi-select. '' = "All sources" (clear the set).
  const toggleSource = (val: string) => mutate(p => {
    if (!val) { p.delete('source_type'); return; }
    const cur = new Set((p.get('source_type') ?? '').split(',').filter(Boolean));
    if (cur.has(val)) cur.delete(val); else cur.add(val);
    if (cur.size) p.set('source_type', [...cur].join(',')); else p.delete('source_type');
  });

  const clearFilters = () => mutate(p => { for (const k of ['fit', 'remote', 'l1', 'l2', 'source_type']) p.delete(k); });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.jobs.list({
        status: status || undefined,
        l1: l1 ? '1' : undefined,
        l2: l2 ? '1' : undefined,
        fit: fit ? '1' : undefined,
        remote: remote ? '1' : undefined,
        source_type: sourceTypeRaw || undefined,
        q: q || undefined,
        limit: PAGE_LIMIT,
      });
      setJobs(res.jobs);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [status, l1, l2, fit, remote, sourceTypeRaw, q]);

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

  const hasFilters = !!(status || l1 || l2 || fit || remote || sourceTypeRaw || q);

  return (
    <div className="jobs-main" style={{ position: 'relative', padding: 'var(--space-xl)', maxWidth: 1100, margin: '0 auto', marginRight: selected ? 'min(480px, 94vw)' : 'auto', transition: 'margin-right 220ms cubic-bezier(0.22,1,0.36,1)' }}>
      {/* Ambient warmth — a soft lantern glow in the top-right corner. Kept high so
          its transparent edge lands ABOVE the sticky control bar; otherwise the
          bar's opaque background clips it into a hard seam. */}
      <div aria-hidden style={{ position: 'absolute', top: -240, right: -100, width: 460, height: 320, pointerEvents: 'none', zIndex: 0, background: 'radial-gradient(50% 50% at 50% 50%, var(--orb-1), transparent 70%)', opacity: 0.4, filter: 'blur(24px)' }} />

      <div style={{ position: 'relative', zIndex: 1 }}>
      {/* Masthead: serif title + count on the left, quiet search on the right. */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, marginBottom: 'var(--space-lg)' }}>
        <div>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 'clamp(28px, 3.4vw, 34px)', fontWeight: 500, color: 'var(--text)', letterSpacing: '-0.02em', lineHeight: 1 }}>Jobs</h1>
          {!loading && (
            <p style={{ margin: '10px 0 0', fontSize: '13.5px', color: 'var(--text-muted)' }}>
              <span className="tnum" style={{ color: 'var(--text)' }}>{total.toLocaleString()}</span> {total === 1 ? 'role' : 'roles'}
              <span style={{ color: 'var(--text-faint)' }}> · ranked by fit</span>
              {total > PAGE_LIMIT && <span style={{ color: 'var(--text-faint)' }}> · showing top {PAGE_LIMIT}</span>}
            </p>
          )}
        </div>
        <SearchField q={q} onQ={v => setParam('q', v)} />
      </header>

      {/* Control bar: status section-nav (primary) + one Refine popover (secondary).
          Sticky so triage filters stay reachable while scrolling a long list. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderBottom: '1px solid var(--border)', marginBottom: 6 }}>
        <StatusNav status={status} onStatus={v => setParam('status', v)} />
        <div style={{ paddingBottom: 7 }}>
          <RefineControl
            fit={fit} remote={remote} l1={l1} l2={l2} sourceTypes={sourceTypes}
            onFit={v => setParam('fit', v ? '1' : '')}
            onRemote={v => setParam('remote', v ? '1' : '')}
            onL1={v => setParam('l1', v ? '1' : '')}
            onL2={v => setParam('l2', v ? '1' : '')}
            onToggleSource={toggleSource}
            onClearAll={clearFilters}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '90px 0' }}><Spinner size={20} /></div>
      ) : jobs.length === 0 ? (
        <EmptyState hasFilters={hasFilters} />
      ) : (
        <>
          <div className="jobs-grid" style={{ display: 'grid', gridTemplateColumns: GRID, columnGap: 18, padding: '14px 14px 9px' }}>
            {([
              ['Fit', ''], ['Role', ''], ['Location', 'col-location'], ['Status', ''], ['Age', 'col-seen'],
            ] as const).map(([h, cls], i) => (
              <span key={h} className={cls} style={{ fontSize: '10.5px', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: i === 4 ? 'right' : 'left' }}>{h}</span>
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
      </div>

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
