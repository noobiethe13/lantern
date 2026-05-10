import type { JobStatus } from '@/lib/api';

const STATUS_CONFIG: Record<JobStatus, { label: string; bg: string; color: string }> = {
  new:       { label: 'New',        bg: '#27272a',                      color: '#a1a1aa' },
  shortlist: { label: 'Shortlist',  bg: 'rgba(99,102,241,0.15)',        color: '#818cf8' },
  applied:   { label: 'Applied',    bg: 'rgba(59,130,246,0.15)',        color: '#60a5fa' },
  interview: { label: 'Interview',  bg: 'rgba(245,158,11,0.15)',        color: '#fbbf24' },
  offer:     { label: 'Offer',      bg: 'rgba(34,197,94,0.15)',         color: '#4ade80' },
  rejected:  { label: 'Rejected',   bg: 'rgba(239,68,68,0.12)',         color: '#f87171' },
  hidden:    { label: 'Hidden',     bg: '#1c1c1e',                      color: '#52525b' },
  archived:  { label: 'Archived',   bg: '#1c1c1e',                      color: '#3f3f46' },
};

interface StatusPillProps {
  status: JobStatus;
  interactive?: boolean;
  onChange?: (status: JobStatus) => void;
}

const ALL_STATUSES: JobStatus[] = [
  'new', 'shortlist', 'applied', 'interview', 'offer', 'rejected', 'hidden', 'archived',
];

export function StatusPill({ status, interactive, onChange }: StatusPillProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;

  if (!interactive) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: '5px',
          fontSize: '11px',
          fontWeight: 500,
          letterSpacing: '0.01em',
          background: cfg.bg,
          color: cfg.color,
        }}
      >
        {cfg.label}
      </span>
    );
  }

  return (
    <select
      value={status}
      onChange={e => onChange?.(e.target.value as JobStatus)}
      style={{
        background: cfg.bg,
        color: cfg.color,
        border: 'none',
        borderRadius: '5px',
        fontSize: '11px',
        fontWeight: 500,
        padding: '2px 6px',
        cursor: 'pointer',
        outline: 'none',
        appearance: 'none',
        WebkitAppearance: 'none',
        letterSpacing: '0.01em',
      }}
    >
      {ALL_STATUSES.map(s => (
        <option key={s} value={s} style={{ background: '#111', color: '#e4e4e7' }}>
          {STATUS_CONFIG[s].label}
        </option>
      ))}
    </select>
  );
}
