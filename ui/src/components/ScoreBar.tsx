import { useState } from 'react';
import type { Verdict } from '@/lib/api';

interface ScoreBarProps {
  verdict: Verdict;
  width?: number;
}

function scoreColor(score: number): string {
  // Red → amber → green interpolation
  if (score < 0.5) {
    const t = score * 2; // 0→1 in red→amber range
    const r = Math.round(239 + (245 - 239) * t);
    const g = Math.round(68 + (158 - 68) * t);
    const b = Math.round(68 + (11 - 68) * t);
    return `rgb(${r},${g},${b})`;
  } else {
    const t = (score - 0.5) * 2; // 0→1 in amber→green range
    const r = Math.round(245 + (34 - 245) * t);
    const g = Math.round(158 + (197 - 158) * t);
    const b = Math.round(11 + (94 - 11) * t);
    return `rgb(${r},${g},${b})`;
  }
}

export function ScoreBar({ verdict, width = 80 }: ScoreBarProps) {
  const [hovered, setHovered] = useState(false);
  const pct = Math.round(verdict.score * 100);
  const color = scoreColor(verdict.score);

  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Track */}
      <div
        style={{
          width,
          height: 3,
          background: 'var(--border)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 2,
            transition: 'width 400ms ease-out',
          }}
        />
      </div>

      {/* Percentage */}
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          color: color,
          fontVariantNumeric: 'tabular-nums',
          minWidth: '28px',
        }}
      >
        {pct}%
      </span>

      {/* Tooltip */}
      {hovered && verdict.reasons.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            background: '#1c1c1e',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '10px 12px',
            zIndex: 50,
            width: 240,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            animation: 'fadeIn 120ms ease-out',
          }}
        >
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: 6, fontWeight: 500 }}>
            {verdict.seniority} · {verdict.remote_confirmed ? 'remote confirmed' : 'location varies'}
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {verdict.reasons.map((r, i) => (
              <li key={i} style={{ fontSize: '12px', color: 'var(--text)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ color: color, marginTop: 2, flexShrink: 0 }}>·</span>
                {r}
              </li>
            ))}
          </ul>
          {verdict.stack_match.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {verdict.stack_match.map(s => (
                <span
                  key={s}
                  style={{
                    fontSize: '10px',
                    padding: '1px 6px',
                    background: 'var(--accent-muted)',
                    color: 'var(--accent-hover)',
                    borderRadius: '4px',
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
