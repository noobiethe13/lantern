import type { JobStatus } from '@/lib/api';

const STATUS_CONFIG: Record<JobStatus, { label: string; color: string }> = {
  new:       { label: 'New',        color: 'var(--text-faint)' },
  shortlist: { label: 'Shortlist',  color: 'var(--accent-text)' },
  applied:   { label: 'Applied',    color: 'var(--tone-blue)' },
  interview: { label: 'Interview',  color: 'var(--tone-violet)' },
  offer:     { label: 'Offer',      color: 'var(--success)' },
  rejected:  { label: 'Rejected',   color: 'var(--danger)' },
  hidden:    { label: 'Hidden',     color: 'var(--text-faint)' },
  archived:  { label: 'Archived',   color: 'var(--text-faint)' },
};

const ALL_STATUSES: JobStatus[] = [
  'new', 'shortlist', 'applied', 'interview', 'offer', 'rejected', 'hidden', 'archived',
];

interface StatusPillProps {
  status: JobStatus;
  interactive?: boolean;
  onChange?: (status: JobStatus) => void;
}

export function StatusPill({ status, interactive, onChange }: StatusPillProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.new;

  const dot = (
    <span
      style={{
        width: 6, height: 6, borderRadius: '50%',
        background: cfg.color, flexShrink: 0,
      }}
    />
  );

  if (!interactive) {
    return (
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)',
        }}
      >
        {dot}
        {cfg.label}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {dot}
      <select
        aria-label="Job status"
        value={status}
        onChange={e => onChange?.(e.target.value as JobStatus)}
        style={{
          background: 'var(--surface)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '12px',
          fontWeight: 500,
          fontFamily: 'inherit',
          padding: '4px 8px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {ALL_STATUSES.map(s => (
          <option key={s} value={s}>
            {STATUS_CONFIG[s].label}
          </option>
        ))}
      </select>
    </span>
  );
}
