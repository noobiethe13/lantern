import { useState } from 'react';
import type { Verdict } from '@/lib/api';

interface ScoreBarProps {
  verdict: Verdict;
  width?: number;
}

// Perceptual red → amber → green ramp in OKLCH. Fixed lightness/chroma so it
// reads on both light and dark fields; hue carries the signal.
function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  const hue = 25 + s * (148 - 25); // 25 (red) → 148 (green), passing ~86 amber
  return `oklch(0.64 0.16 ${hue.toFixed(0)})`;
}

/**
 * Circular fit-score gauge — echoes lantern's concentric-ring motif. Used in the
 * job detail panel as the headline stat.
 */
export function ScoreRing({ score, size = 60 }: { score: number; size?: number }) {
  const pct = Math.round(score * 100);
  const color = scoreColor(score);
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const c = size / 2;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
        <circle
          cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - score)}
          style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span className="tnum" style={{ fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: 600, color: 'var(--text)', lineHeight: 1 }}>{pct}</span>
        <span style={{ fontSize: '8.5px', color: 'var(--text-faint)', letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 1 }}>fit</span>
      </div>
    </div>
  );
}

export function ScoreBar({ verdict, width = 80 }: ScoreBarProps) {
  const [hovered, setHovered] = useState(false);
  const pct = Math.round(verdict.score * 100);
  const color = scoreColor(verdict.score);

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          width,
          height: 3,
          background: 'var(--border)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: color,
            borderRadius: 'var(--radius-full)',
            transformOrigin: 'left',
            transform: `scaleX(${pct / 100})`,
            transition: 'transform 400ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </div>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '11.5px',
          color,
          fontVariantNumeric: 'tabular-nums',
          minWidth: '30px',
        }}
      >
        {pct}%
      </span>

      {hovered && verdict.reasons.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '11px 13px',
            zIndex: 50,
            width: 250,
            boxShadow: 'var(--shadow-md)',
            animation: 'fadeIn 120ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 7, fontWeight: 500 }}>
            {verdict.seniority} · {verdict.remote_confirmed ? 'remote confirmed' : 'location varies'}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {verdict.reasons.map((r, i) => (
              <li key={i} style={{ fontSize: '12px', color: 'var(--text)', display: 'flex', gap: 7, alignItems: 'flex-start', lineHeight: 1.45 }}>
                <span style={{ color, marginTop: 1, flexShrink: 0 }}>·</span>
                {r}
              </li>
            ))}
          </ul>
          {verdict.stack_match.length > 0 && (
            <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {verdict.stack_match.map(s => (
                <span
                  key={s}
                  style={{
                    fontSize: '10.5px',
                    padding: '1px 7px',
                    background: 'var(--accent-muted)',
                    color: 'var(--accent-text)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
