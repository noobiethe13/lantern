import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { JobStatus } from '@/lib/api';

const STATUS_CONFIG: Record<JobStatus, { label: string; color: string }> = {
  new:       { label: 'New',        color: 'var(--text-muted)' },
  shortlist: { label: 'Shortlist',  color: 'var(--accent-text)' },
  applied:   { label: 'Applied',    color: 'var(--tone-blue)' },
  interview: { label: 'Interview',  color: 'var(--tone-violet)' },
  offer:     { label: 'Offer',      color: 'var(--success)' },
  rejected:  { label: 'Rejected',   color: 'var(--danger)' },
  hidden:    { label: 'Hidden',     color: 'var(--text-faint)' },
};

const ALL_STATUSES: JobStatus[] = [
  'new', 'shortlist', 'applied', 'interview', 'offer', 'rejected', 'hidden',
];

interface StatusPillProps {
  status: JobStatus;
  interactive?: boolean;
  onChange?: (status: JobStatus) => void;
}

function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0 }} />;
}

export function StatusPill({ status, interactive, onChange }: StatusPillProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Read-only: a colored dot + label (no box). The dot color forms a scannable
  // band down the status column without the boxiness of a filled chip.
  if (!interactive) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '12.5px', fontWeight: 500, color: cfg.color, whiteSpace: 'nowrap' }}>
        <Dot color={cfg.color} />
        {cfg.label}
      </span>
    );
  }

  // Interactive: a custom dropdown (not a native <select>, which looks out of
  // place against the rest of the UI). Button shows the current status as a
  // tinted pill; the popover lists every status with a colored dot.
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          fontSize: '13px', fontWeight: 550, color: cfg.color,
          padding: '6px 10px 6px 13px', borderRadius: 'var(--radius-md)',
          background: `color-mix(in oklch, ${cfg.color} 14%, transparent)`,
          border: `1px solid color-mix(in oklch, ${cfg.color} 30%, transparent)`,
          cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}
      >
        <Dot color={cfg.color} />
        {cfg.label}
        <ChevronDown size={13} style={{ color: 'var(--text-faint)', transition: 'transform 150ms ease', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 'calc(100% + 5px)', left: 0, zIndex: 50,
            minWidth: 168, padding: 4,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)',
            animation: 'fadeIn 120ms cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          {ALL_STATUSES.map(s => {
            const c = STATUS_CONFIG[s];
            const active = s === status;
            return (
              <button
                key={s}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onChange?.(s); setOpen(false); }}
                className="status-opt"
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                  padding: '7px 9px', background: active ? 'var(--surface-2)' : 'transparent',
                  border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: '13px', color: 'var(--text)', textAlign: 'left',
                }}
              >
                <Dot color={c.color} size={7} />
                <span style={{ flex: 1 }}>{c.label}</span>
                {active && <Check size={13} style={{ color: 'var(--accent-text)' }} />}
              </button>
            );
          })}
          <style>{`.status-opt:hover{background:var(--surface-2);}`}</style>
        </div>
      )}
    </div>
  );
}
