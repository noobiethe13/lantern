import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ExternalLink, MapPin, Globe, X, Banknote, GaugeCircle, Clock, ShieldAlert, Sparkles, Layers, EyeOff,
  ChevronUp, ChevronDown, Star, RotateCcw,
} from 'lucide-react';
import { api, type Job, type JobStatus, type SimilarJob } from '@/lib/api';
import { Textarea, Kbd, useToast } from '@/components/ui';
import { StatusPill } from '@/components/StatusPill';
import { scoreColor } from '@/components/score';
import { ageOf, fitLabel, isFlagged, legitimacyColor, salaryOf } from './shared';

const NOTES_MAX_LEN = 4000;
const JD_PREVIEW = 2400;

/**
 * Everything about one role, set like a page: who and what, the facts in one
 * line, Claude's verdict beside its reasons, then the posting itself in the
 * reading serif. A sticky bar keeps the triage actions in reach while you read.
 *
 * `pane` sits in the Jobs split view; `drawer` slides over the list when the
 * window is too narrow for two columns.
 */
export function JobDetail({ job, mode, onClose, onStatusChange, onDismiss, onShortlist, restoreTo, onNotesSaved, onPrev, onNext }: {
  job: Job;
  mode: 'pane' | 'drawer';
  onClose: () => void;
  onStatusChange: (s: JobStatus) => void;
  onDismiss: () => void;
  onShortlist: () => void;
  restoreTo: JobStatus;
  onNotesSaved: (id: number, notes: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const toast = useToast();
  const [notes, setNotes] = useState(job.notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [showFullJd, setShowFullJd] = useState(false);
  const [similar, setSimilar] = useState<SimilarJob[]>([]);
  const [duplicates, setDuplicates] = useState<Job[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Pending (debounced, not-yet-sent) note edit — keyed by job id so a flush
  // triggered by switching jobs saves the *right* job, not whichever is current.
  const pendingNotesRef = useRef<{ id: number; val: string } | null>(null);

  // Sends whatever edit is pending (if any) right away, bypassing the debounce.
  // Called both from the debounce timer itself and from the job-change/unmount
  // cleanup below, so a fast Next/Prev never silently drops an in-flight edit.
  const flushNotes = useCallback(() => {
    clearTimeout(notesTimer.current);
    const pending = pendingNotesRef.current;
    if (!pending) return;
    pendingNotesRef.current = null;
    setSavingNotes(true);
    api.jobs.setNotes(pending.id, pending.val)
      .then(() => onNotesSaved(pending.id, pending.val))
      .catch(e => toast(`Note didn't save: ${String(e instanceof Error ? e.message : e)}`, 'error'))
      .finally(() => setSavingNotes(false));
  }, [onNotesSaved, toast]);

  useEffect(() => {
    setNotes(job.notes ?? '');
    setShowFullJd(false);
    scrollRef.current?.scrollTo({ top: 0 });
    // Leaving this job (switch or unmount): flush its pending edit instead of
    // dropping it — a shared timer used to mean typing in the next job within
    // 800ms cancelled the previous job's unsaved note entirely.
    return () => { flushNotes(); };
  }, [job.id, flushNotes]);

  // Nearest-neighbour jobs by embedding. Best-effort: a stale/disabled embedding
  // store just yields an empty list, and the section hides itself.
  useEffect(() => {
    let live = true;
    setSimilar([]);
    api.jobs.similar(job.id).then(res => { if (live) setSimilar(res.jobs); }).catch(e => console.error('similar jobs failed', e));
    return () => { live = false; };
  }, [job.id]);

  // Near-duplicate reposts folded into this canonical job (skipped by L2). Only
  // fetch when the count says there are some.
  useEffect(() => {
    let live = true;
    setDuplicates([]);
    if (job.duplicate_count) {
      api.jobs.duplicates(job.id).then(res => { if (live) setDuplicates(res.jobs); }).catch(e => console.error('duplicates failed', e));
    }
    return () => { live = false; };
  }, [job.id, job.duplicate_count]);

  const handleNotes = (val: string) => {
    setNotes(val);
    pendingNotesRef.current = { id: job.id, val };
    clearTimeout(notesTimer.current);
    notesTimer.current = setTimeout(flushNotes, 800);
  };

  const v = job.l2_verdict;
  const salary = salaryOf(job);
  const age = ageOf(job);
  // Drop empty/whitespace reasons so a verdict with no real reason text doesn't
  // render an empty "why it matched" section.
  const reasons = (v?.reasons ?? []).filter(r => r.trim().length > 0);
  const gaps = (v?.gaps ?? []).filter(g => g.trim().length > 0);
  const legitimacyReasons = (job.legitimacy_reasons ?? []).filter(r => r.note.trim().length > 0);
  const hidden = job.status === 'hidden';
  const shortlisted = job.status === 'shortlist';

  const jdText = job.jd_text ?? '';
  const jdTruncated = jdText.length > JD_PREVIEW;
  const jdShown = showFullJd ? jdText : jdText.slice(0, JD_PREVIEW);
  const pct = v ? Math.round(v.score * 100) : 0;

  return (
    <aside className={`detail-panel jd jd-${mode}`} aria-label={`${job.title} at ${job.company}`}>
      <div className="jd-bar">
        <div className="jd-nav">
          <button onClick={onPrev} disabled={!onPrev} aria-label="Previous job (k)" title="Previous (k)" className="jd-icon-btn"><ChevronUp size={15} /></button>
          <button onClick={onNext} disabled={!onNext} aria-label="Next job (j)" title="Next (j)" className="jd-icon-btn"><ChevronDown size={15} /></button>
        </div>
        <div className="jd-actions">
          <StatusPill status={job.status as JobStatus} interactive onChange={onStatusChange} />
          <button type="button" className="jd-btn" data-on={shortlisted || undefined} onClick={onShortlist} title={shortlisted ? 'Remove from shortlist (s)' : 'Shortlist (s)'}>
            <Star size={13} fill={shortlisted ? 'currentColor' : 'none'} />
            {shortlisted ? 'Shortlisted' : 'Shortlist'}
          </button>
          {/* One-click "not for me": the signal lantern learns taste from (it nudges
              ranking only). Undoes itself when the job is already dismissed. */}
          <button
            type="button"
            className="jd-btn"
            onClick={() => (hidden ? onStatusChange(restoreTo) : onDismiss())}
            title={hidden
              ? `Put this job back as ${restoreTo}`
              : job.applied_at != null
              ? 'Hide this job (you applied to it, so it still counts toward what you like) (x)'
              : 'Hide this job and rank similar ones lower (x)'}
          >
            {hidden ? <RotateCcw size={13} /> : <EyeOff size={13} />}
            {hidden ? 'Restore' : 'Not interested'}
          </button>
          <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn btn-default btn-sm" style={{ textDecoration: 'none', gap: 7 }} title="Open posting (o)">
            Open posting <ExternalLink size={13} />
          </a>
          {mode === 'drawer' && (
            <button onClick={onClose} aria-label="Close details" className="jd-icon-btn"><X size={15} /></button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="jd-scroll" tabIndex={-1}>
        {/* the verdict colours the light: an 85 breathes gold, a 12 stays ashen */}
        <div aria-hidden className="jd-glow" style={{ background: `radial-gradient(50% 50% at 50% 50%, color-mix(in oklch, ${v ? scoreColor(v.score) : 'var(--accent)'} 22%, transparent), transparent 70%)` }} />

        <article key={job.id} className="jd-body">
          <header>
            <div className="jd-eyebrow">
              <span style={{ color: 'var(--text)', fontWeight: 550 }}>{job.company}</span>
              {job.source_name && <span> · {job.source_name}</span>}
              {job.l1_rescued === 1 && <span title="Title didn't match the search, but the description reads like it"> · semantic match</span>}
            </div>
            <h2 className="jd-title">{job.title}</h2>
            <div className="jd-facts">
              <span>{job.remote === 1 ? <Globe size={13} /> : <MapPin size={13} />}{job.remote === 1 ? 'Remote' : job.location || 'Location not stated'}</span>
              {salary && (
                <span className="tnum" title={salary.fromText ? 'Read from the job description, not stated by the board' : salary.estimated ? "Claude's estimate from the description" : undefined}>
                  <Banknote size={13} />{salary.fromText ? '≈ ' : ''}{salary.text}{salary.estimated && <span className="jd-faint"> est.</span>}
                </span>
              )}
              {v?.seniority && v.seniority !== 'unknown' && <span style={{ textTransform: 'capitalize' }}><GaugeCircle size={13} />{v.seniority}</span>}
              <span title={age.title}><Clock size={13} />{age.long}</span>
            </div>
            {(isFlagged(job) || v?.remote_confirmed) && (
              <div className="jd-flags">
                {isFlagged(job) && (
                  <span className="jd-flag" style={{ ['--c' as string]: legitimacyColor(job.legitimacy!) }}>
                    <ShieldAlert size={11} /> {job.legitimacy === 'suspicious' ? 'Possible ghost listing' : 'Staleness signals'}
                  </span>
                )}
                {v?.remote_confirmed && (
                  <span className="jd-flag" style={{ ['--c' as string]: 'var(--tone-blue)' }}><Globe size={11} /> Remote confirmed</span>
                )}
              </div>
            )}
          </header>

          {/* The verdict: Claude's number on the left, its reasons beside it, so the
              score is never read without the why. */}
          <section className="jd-verdict">
            <div>
              {v ? (
                <>
                  <div className="jd-score tnum" style={{ color: scoreColor(v.score), textShadow: v.score >= 0.7 ? '0 0 22px color-mix(in oklch, var(--score-hot) 50%, transparent)' : undefined }}>
                    {pct}<span>%</span>
                  </div>
                  <div className="jd-score-label" style={{ color: scoreColor(v.score) }}>{fitLabel(v.score)}</div>
                  <div className="jd-score-bar"><span style={{ width: `${pct}%`, background: scoreColor(v.score) }} /></div>
                </>
              ) : (
                <>
                  <div className="jd-score tnum" style={{ color: 'var(--text-faint)' }}>—</div>
                  <div className="jd-score-label">{job.l1_pass === 1 ? 'Passed filters, not yet scored' : 'Not scored'}</div>
                </>
              )}
            </div>
            <div>
              <div className="jd-label">Why it matched</div>
              {reasons.length > 0 ? (
                <ol className="jd-reasons">
                  {reasons.map((r, i) => (
                    <li key={i}><span className="tnum">{String(i + 1).padStart(2, '0')}</span>{r}</li>
                  ))}
                </ol>
              ) : (
                <p className="jd-faint" style={{ margin: 0, fontSize: '13px' }}>
                  {v ? 'Claude gave no reasons for this one.' : 'Scored roles show Claude’s reasons here.'}
                </p>
              )}
            </div>
          </section>

          {v?.stack_match && v.stack_match.length > 0 && (
            <section className="jd-section">
              <div className="jd-label">Stack match</div>
              <div className="jd-chips">
                {v.stack_match.map(s => <span key={s}>{s}</span>)}
              </div>
            </section>
          )}

          {/* Resume fit — present only when the job was scored with resume-aware
              grading on: how the job matches *you*, with the gaps named. */}
          {v?.background_fit != null && (
            <section className="jd-section">
              <div className="jd-label">Against your resume</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: gaps.length > 0 ? 10 : 0 }}>
                <span className="tnum" style={{ fontFamily: 'var(--font-mono)', fontSize: '19px', fontWeight: 600, color: scoreColor(v.background_fit), lineHeight: 1 }}>
                  {Math.round(v.background_fit * 100)}<span style={{ fontSize: '12px', marginLeft: 1 }}>%</span>
                </span>
                <div className="jd-score-bar" style={{ flex: 1, marginTop: 0 }}><span style={{ width: `${Math.round(v.background_fit * 100)}%`, background: scoreColor(v.background_fit) }} /></div>
              </div>
              {gaps.length > 0 && (
                <ul className="jd-list">
                  {gaps.map((g, i) => <li key={i}><span aria-hidden style={{ color: 'var(--warning)' }}>–</span>{g}</li>)}
                </ul>
              )}
            </section>
          )}

          <section className="jd-section">
            <div className="jd-label">The posting</div>
            {jdText ? (
              <>
                <div className="jd-prose" data-clipped={jdTruncated && !showFullJd ? true : undefined}>
                  {jdShown}{jdTruncated && !showFullJd ? '…' : ''}
                </div>
                {jdTruncated && (
                  <button className="jd-more" onClick={() => setShowFullJd(s => !s)}>
                    {showFullJd ? 'Show less' : 'Read the full description'}
                  </button>
                )}
              </>
            ) : (
              <p className="jd-faint" style={{ fontStyle: 'italic', margin: 0, fontSize: '13px' }}>No description captured. The posting itself has it.</p>
            )}
          </section>

          <section className="jd-section">
            <div className="jd-label">
              Notes {savingNotes && <span style={{ color: 'var(--accent-text)', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>· saving</span>}
            </div>
            <Textarea value={notes} onChange={e => handleNotes(e.target.value)} placeholder="Recruiter name, referral, what stood out…" rows={3} maxLength={NOTES_MAX_LEN} style={{ fontFamily: 'var(--font-ui)', fontSize: '13.5px' }} />
          </section>

          {/* Posting legitimacy — deterministic ghost-job signals from run history,
              posting age, JD quality and liveness. 'high' means "no red flags
              found", never "verified real", so the copy stays in that register. */}
          {job.legitimacy && (
            <section className="jd-section">
              <div className="jd-label">Posting legitimacy</div>
              {legitimacyReasons.length > 0 ? (
                <ul className="jd-list">
                  {legitimacyReasons.map((r, i) => (
                    <li key={i}>
                      <span aria-hidden style={{ color: r.kind === 'positive' ? 'var(--accent-text)' : legitimacyColor(job.legitimacy === 'high' ? 'caution' : job.legitimacy!) }}>
                        {r.kind === 'positive' ? '+' : '!'}
                      </span>
                      {r.note}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="jd-faint" style={{ fontSize: '13px', margin: 0 }}>No red flags found.</p>
              )}
            </section>
          )}

          {/* Near-duplicate reposts — kept but skipped by L2, so we say so: the
              user shouldn't wonder why these have no score. */}
          {duplicates.length > 0 && (
            <section className="jd-section">
              <div className="jd-label"><Layers size={11} />Also posted on</div>
              <p className="jd-faint" style={{ margin: '-2px 0 8px', fontSize: '12px' }}>Same role detected on other boards, not scored separately.</p>
              <LinkList items={duplicates.map(d => ({ id: d.id, url: d.url, title: d.title, sub: `${d.company}${d.source_name ? ` · ${d.source_name}` : ''}` }))} />
            </section>
          )}

          {/* Similar jobs — nearest neighbours by local embedding. Hidden when the
              store has no embedded neighbours yet. */}
          {similar.length > 0 && (
            <section className="jd-section">
              <div className="jd-label"><Sparkles size={11} />Reads like this</div>
              <LinkList items={similar.map(s => ({ id: s.id, url: s.url, title: s.title, sub: `${s.company}${s.source_name ? ` · ${s.source_name}` : ''}`, meta: `${Math.round(s.similarity * 100)}%` }))} />
            </section>
          )}

          <footer className="jd-foot tnum">
            First seen {new Date(job.first_seen).toLocaleDateString()}
            {job.posted_at != null && <> · Posted {new Date(job.posted_at).toLocaleDateString()}</>}
          </footer>
        </article>
      </div>

      {mode === 'drawer' && (
        <div aria-hidden className="jd-keys">
          <span><Kbd>J</Kbd><Kbd>K</Kbd> move</span>
          <span><Kbd>S</Kbd> shortlist</span>
          <span><Kbd>X</Kbd> not interested</span>
          <span><Kbd>O</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      )}
    </aside>
  );
}

function LinkList({ items }: { items: { id: number; url: string; title: string; sub: string; meta?: string }[] }) {
  return (
    <ul className="jd-links">
      {items.map(it => (
        <li key={it.id}>
          <a href={it.url} target="_blank" rel="noopener noreferrer">
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="jd-link-title">{it.title}</span>
              <span className="jd-link-sub">{it.sub}</span>
            </span>
            {it.meta && <span className="tnum jd-link-meta" title="Similarity">{it.meta}</span>}
            <ExternalLink size={12} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** What the reading pane shows before anything is picked. */
export function PanePlaceholder() {
  return (
    <div className="jd-placeholder">
      <p className="jobs-empty-title">Pick a role to <em>read</em> it</p>
      <div className="jd-placeholder-keys">
        <span><Kbd>J</Kbd><Kbd>K</Kbd> move through the list</span>
        <span><Kbd>S</Kbd> shortlist</span>
        <span><Kbd>X</Kbd> not interested</span>
        <span><Kbd>O</Kbd> open the posting</span>
        <span><Kbd>/</Kbd> filter</span>
      </div>
    </div>
  );
}
