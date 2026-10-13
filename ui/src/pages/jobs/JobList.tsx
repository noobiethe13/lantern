import { memo } from 'react';
import { ShieldAlert, Layers, Globe } from 'lucide-react';
import type { Job, JobStatus, Legitimacy } from '@/lib/api';
import { Button, Skeleton } from '@/components/ui';
import { StatusPill } from '@/components/StatusPill';
import { scoreColor } from '@/components/score';
import { EmptyLantern } from '@/components/brand';
import { ageOf, fitLabel, isFlagged, legitimacyColor, PREF_HINT_MIN, TRIAGED_STATUSES } from './shared';

/**
 * One role in the triage list. Three columns: the fit numeral over a short heat
 * bar (the ranking spine: weak scores cool to ash, strong fits glow gold), the
 * role in the serif voice over company and place, then age and any status the
 * user has given it. Defaults (status 'new', remote) render near-silent so the
 * exceptions are what you see.
 */
export const JobRow = memo(function JobRow({ job, selected, index, onSelect }: {
  job: Job; selected: boolean; index: number; onSelect: (id: number) => void;
}) {
  const v = job.l2_verdict;
  const age = ageOf(job);
  const flags = isFlagged(job) ? (job.legitimacy_reasons ?? []).filter(r => r.kind === 'flag').map(r => r.note) : [];
  const place = job.remote === 1 ? 'Remote' : job.location;
  const hint = job.l1_rescued === 1
    ? { text: 'semantic match', title: "Title didn't match the search, but the description reads like it" }
    : job.status === 'new' && (job.pref_adjust ?? 0) >= PREF_HINT_MIN
    ? { text: 'like your shortlist', title: "Ranked a little higher because it reads like jobs you've shortlisted" }
    : null;

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-job-id={job.id}
      data-hidden={job.status === 'hidden' || undefined}
      className="jrow"
      onClick={() => onSelect(job.id)}
      style={{ animationDelay: `${Math.min(index * 10, 120)}ms` }}
    >
      <div className="jrow-fit">
        {v ? (
          <div title={`${Math.round(v.score * 100)}% fit · ${fitLabel(v.score)}`}>
            <span className="jrow-score tnum" style={{ color: scoreColor(v.score), textShadow: v.score >= 0.7 ? '0 0 14px color-mix(in oklch, var(--score-hot) 55%, transparent)' : undefined }}>
              {Math.round(v.score * 100)}
            </span>
            <span aria-hidden className="jrow-bar"><span style={{ width: `${Math.round(v.score * 100)}%`, background: scoreColor(v.score) }} /></span>
          </div>
        ) : (
          <span className="jrow-unscored" title={job.l1_pass === 1 ? 'Passed filters, not yet scored' : 'Not scored'}>{job.l1_pass === 1 ? 'L1' : '—'}</span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div className="jrow-title">
          <span className="jrow-title-text">{job.title}</span>
          {flags.length > 0 && (
            <span title={flags.join(' · ')} aria-label={`Ghost-listing signals: ${flags.join(', ')}`} style={{ display: 'inline-flex', flexShrink: 0, color: legitimacyColor(job.legitimacy as Legitimacy) }}>
              <ShieldAlert size={13} />
            </span>
          )}
        </div>
        <div className="jrow-sub">
          <span className="jrow-company">{job.company}</span>
          {place && (
            <>
              <span className="jrow-dot">·</span>
              {job.remote === 1 && <Globe size={11} style={{ flexShrink: 0, opacity: 0.7 }} />}
              <span className="jrow-place">{place}</span>
            </>
          )}
        </div>
        {(hint || job.duplicate_count) ? (
          <div className="jrow-hints">
            {hint && <span title={hint.title}>{hint.text}</span>}
            {!!job.duplicate_count && (
              <span title={`${job.duplicate_count} near-duplicate repost${job.duplicate_count > 1 ? 's' : ''} folded in`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Layers size={10} />{job.duplicate_count} repost{job.duplicate_count > 1 ? 's' : ''}
              </span>
            )}
          </div>
        ) : null}
      </div>

      <div className="jrow-side">
        <span className="jrow-age tnum" title={age.title} data-today={age.today || undefined}>{age.short}</span>
        {TRIAGED_STATUSES.includes(job.status as JobStatus) && <StatusPill status={job.status as JobStatus} />}
      </div>
    </div>
  );
});

// Mirrors the row layout so the list doesn't jump when data lands.
export function SkeletonRows() {
  const widths = [72, 58, 81, 64, 76, 52, 68, 79, 61];
  return (
    <div aria-busy="true" aria-label="Loading jobs">
      {widths.map((w, i) => (
        <div key={i} className="jrow jrow-skeleton" style={{ opacity: 1 - i * 0.09 }}>
          <div className="jrow-fit"><Skeleton width={24} height={17} /><Skeleton width={26} height={3} style={{ marginTop: 6 }} /></div>
          <div><Skeleton width={`${w}%`} height={15} /><Skeleton width={`${w * 0.6}%`} height={11} style={{ marginTop: 8 }} /></div>
          <div className="jrow-side"><Skeleton width={20} height={10} /></div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="jobs-empty">
      <EmptyLantern size={112} dim={!hasFilters} />
      <p className="jobs-empty-title">
        {hasFilters ? <>Nothing <em>matches</em></> : <>No matches <em>yet</em></>}
      </p>
      <p className="jobs-empty-sub">
        {hasFilters ? 'Try clearing filters or running a new search.' : 'Run a search and Lantern will light up matching jobs.'}
      </p>
    </div>
  );
}

// Distinct from EmptyState: this is "the request failed", not "there's nothing
// here" — wrong copy on a 500 would read as if the search genuinely had no
// results.
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="jobs-empty">
      <EmptyLantern size={112} dim />
      <p className="jobs-empty-title">Couldn't load <em style={{ color: 'var(--danger)' }}>jobs</em></p>
      <p className="jobs-empty-sub">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry} style={{ marginTop: 6 }}>Retry</Button>
    </div>
  );
}
