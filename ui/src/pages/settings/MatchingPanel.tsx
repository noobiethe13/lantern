import { useState, useEffect, useRef } from 'react';
import { FileUp } from 'lucide-react';
import { api, type ResumeSettings, type EmbeddingSettings, type Calibration, type TasteStats } from '@/lib/api';
import { Button, Textarea, Switch, useToast } from '@/components/ui';
import { PanelHeader, SettingRow, RowLoading, errText } from './parts';

export function MatchingPanel() {
  return (
    <>
      <PanelHeader title="Matching" intro="How each role is judged once it's found: against your resume, in what order, and how your own decisions feed back in." />
      <ResumeSetting />
      <SemanticSetting />
      <TasteSetting />
    </>
  );
}

// The switch saves on its own (with the stored text); the text saves with its
// Save button (with the current switch). Each write sends the whole object, so
// neither can clobber the other's stored half.
function ResumeSetting() {
  const toast = useToast();
  const [saved, setSaved] = useState<ResumeSettings | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.resume.get().then(res => { setSaved(res.settings); setText(res.settings.text); })
      .catch(e => { console.error('resume settings failed', e); setSaved({ enabled: false, text: '' }); });
  }, []);

  const save = async (next: ResumeSettings) => {
    setBusy(true);
    try {
      const res = await api.resume.save(next);
      setSaved(res.settings);
      toast(next.enabled
        ? 'Resume saved. Current scores are cleared and re-graded with background fit on your next search.'
        : 'Resume grading off. Current scores are cleared and re-graded on your next search.', 'success');
    } catch (e) {
      toast(`Could not save: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handlePdf = async (file: File) => {
    setExtracting(true);
    try {
      const { text: extracted } = await api.resume.extract(file);
      setText(extracted);
      toast('Text extracted. Review it, then save.', 'success');
    } catch (e) {
      toast(errText(e), 'error');
    } finally {
      setExtracting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const dirty = saved !== null && text !== saved.text;

  return (
    <SettingRow
      title="Grade against my resume"
      desc="Adds a background-fit score and a list of gaps to every match, alongside the criteria score. The text stays on this machine."
      control={saved && <Switch checked={saved.enabled} busy={busy} onChange={v => save({ enabled: v, text: saved.text })} label="Grade against my resume" />}
    >
      {saved === null ? <RowLoading /> : (
        <>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Paste your resume as plain text, or import a PDF…"
            rows={8}
            maxLength={50000}
            aria-label="Resume text"
          />
          <div className="row-actions">
            <input ref={fileRef} type="file" accept="application/pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handlePdf(f); }} />
            <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} loading={extracting}>
              <FileUp size={13} /> Import from PDF
            </Button>
            <span className="text-faint" style={{ fontSize: '11.5px' }}>Only the text is kept, never the PDF.</span>
            <span style={{ flex: 1 }} />
            {dirty && <Button size="sm" variant="ghost" onClick={() => setText(saved.text)}>Discard</Button>}
            {dirty && <Button size="sm" onClick={() => save({ enabled: saved.enabled, text })} loading={busy}>Save text</Button>}
          </div>
        </>
      )}
    </SettingRow>
  );
}

function SemanticSetting() {
  const toast = useToast();
  const [saved, setSaved] = useState<EmbeddingSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.embeddings.get().then(res => setSaved(res.settings))
      .catch(e => { console.error('embedding settings failed', e); setSaved({ enabled: true }); });
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const res = await api.embeddings.save({ enabled });
      setSaved(res.settings);
      toast(enabled ? 'Semantic ranking on. The model downloads once on your next search.' : 'Semantic ranking off.', 'success');
    } catch (e) {
      toast(`Could not save: ${errText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title="Semantic ranking"
      desc="A small on-device model orders each search's survivors so the best matches are graded first, and powers “reads like this”. About 25MB, downloaded once; off skips the download entirely."
      control={saved && <Switch checked={saved.enabled} busy={busy} onChange={toggle} label="Semantic ranking" />}
    />
  );
}

function pct(score: number | null): string {
  return score == null ? '—' : String(Math.round(score * 100));
}

function TasteSetting() {
  const [cal, setCal] = useState<Calibration | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.jobs.calibration().then(setCal).catch(e => { console.error('calibration failed', e); setFailed(true); });
  }, []);

  const row = (label: string, stats: TasteStats, flagLabel: string, flag: number) => (
    <div className="taste-row">
      <span>{label}</span>
      <span className="tnum">{stats.triaged}</span>
      <span className="tnum mono">{pct(stats.mean_score)}</span>
      <span className="tnum" style={{ color: flag > 0 ? 'var(--warning)' : 'var(--text-faint)' }}>
        {stats.scored === 0 ? '—' : `${flag} of ${stats.scored} ${flagLabel}`}
      </span>
    </div>
  );

  return (
    <SettingRow
      title="Learned taste"
      desc="Shortlisting, applying to or hiding jobs teaches Lantern what you like. It reorders near-equal matches and the order jobs are graded in; it never decides which jobs pass."
      control={cal && (
        <span className="taste-state" data-on={cal.preference.active || undefined}>
          {cal.preference.active ? 'Active' : 'Learning'}
        </span>
      )}
    >
      {failed ? <p className="panel-note" style={{ color: 'var(--danger)' }}>Could not load the calibration report.</p>
        : cal === null ? <RowLoading />
        : (
          <>
            <p className="panel-note">
              {cal.preference.active
                ? `Reordering results from ${cal.preference.liked} liked${cal.preference.disliked > 0 ? ` and ${cal.preference.disliked} dismissed` : ''} jobs.`
                : 'Shortlist at least three jobs from different companies to switch this on (needs semantic ranking).'}
            </p>
            <div className="taste-table">
              <div className="taste-row taste-head">
                <span>Your call</span><span>Jobs</span><span>Mean score</span><span>Grade vs call</span>
              </div>
              {row('Shortlisted or further', cal.liked, 'graded not a fit', cal.liked.not_fit)}
              {row('Hidden or rejected', cal.disliked, 'graded a fit', cal.disliked.fit)}
            </div>
          </>
        )}
    </SettingRow>
  );
}
