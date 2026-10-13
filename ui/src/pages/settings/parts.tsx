import { useState, useEffect, type ReactNode } from 'react';
import { Button, Input, Spinner } from '@/components/ui';

export function timeAgo(ts: number | null): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

/** A category's opening: serif heading and one sentence on what lives here. */
export function PanelHeader({ title, intro }: { title: string; intro: string }) {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      <p>{intro}</p>
    </header>
  );
}

/**
 * One setting: what it is and why you'd change it on the left, the control on
 * the right, anything bigger (a textarea, a roster, a report) full-width below.
 * Rows sit on hairlines, never in boxes.
 */
export function SettingRow({ title, desc, control, children }: {
  title: ReactNode; desc?: ReactNode; control?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="srow">
      <div className="srow-main">
        <div className="srow-text">
          <h3 className="srow-title">{title}</h3>
          {desc && <p className="srow-desc">{desc}</p>}
        </div>
        {control && <div className="srow-control">{control}</div>}
      </div>
      {children && <div className="srow-body">{children}</div>}
    </div>
  );
}

export function RowLoading() {
  return <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}><Spinner /></div>;
}

/**
 * A number that saves explicitly: Save appears only once the value differs from
 * what's stored, Enter saves, Escape puts it back. The value is clamped before
 * it's sent so the field can't save something the server would reject.
 */
export function NumberSetting({ label, value, unit, min, max, step, width = 76, disabled, onSave }: {
  label: string; value: number; unit: string; min: number; max: number; step?: number; width?: number;
  disabled?: boolean; onSave: (v: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(String(value)); }, [value]);
  const parsed = Math.floor(Number(draft));
  const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
  const dirty = draft.trim() !== '' && clamped !== value;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    try { await onSave(clamped); } finally { setSaving(false); }
  };

  return (
    <div className="num-setting">
      <Input
        type="number" min={min} max={max} step={step} value={draft} disabled={disabled} aria-label={label}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setDraft(String(value));
        }}
        style={{ width, height: 32, fontSize: '13px', textAlign: 'right' }}
        className="tnum"
      />
      <span className="num-unit">{unit}</span>
      {dirty && <Button size="sm" onClick={save} loading={saving}>Save</Button>}
    </div>
  );
}
