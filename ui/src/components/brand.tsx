/**
 * lantern's visual identity — a custom line-art lantern whose core is the warm
 * "glow" accent, plus empty-state illustrations built from the same motif
 * (a lantern casting light through concentric rings). Frame uses currentColor;
 * the glowing core uses the amber accent token.
 */
import type { CSSProperties } from 'react';

export function LanternMark({ size = 22, glow = true, animate = false }: { size?: number; glow?: boolean; animate?: boolean }) {
  const flicker = animate ? { animation: 'flicker 4.5s ease-in-out infinite' } : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      {glow && (
        <circle cx="12" cy="12.2" r="6.5" fill="var(--accent)" opacity="0.16" style={{ filter: 'blur(3px)', transformOrigin: 'center', ...flicker }} />
      )}
      {/* handle */}
      <path d="M9.4 4.1c0-1.43 1.16-2.6 2.6-2.6s2.6 1.17 2.6 2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* top cap */}
      <rect x="7.3" y="4.4" width="9.4" height="2.4" rx="1.2" fill="currentColor" />
      {/* tapered body */}
      <path d="M8.1 7.4h7.8l-.62 9.0c-.05.74-.66 1.3-1.4 1.3H10.1c-.74 0-1.35-.56-1.4-1.3L8.1 7.4Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      {/* base */}
      <rect x="9.1" y="17.9" width="5.8" height="2.2" rx="1.1" fill="currentColor" />
      {/* glowing core */}
      <circle cx="12" cy="11.9" r="2.5" fill="var(--accent)" style={{ transformOrigin: 'center', ...flicker }} />
    </svg>
  );
}

/**
 * Warm light motes drifting up from the lantern — pure-CSS ambient particles for
 * the hero backdrop. Cheap (a handful of dots, transform/opacity only) and
 * disabled under prefers-reduced-motion via the global reset.
 */
const EMBERS = [
  { left: '10%', size: 6, delay: 0.0, dur: 12, x: 26, o: 0.85 },
  { left: '22%', size: 4, delay: 4.5, dur: 15, x: -20, o: 0.7 },
  { left: '34%', size: 5, delay: 2.0, dur: 13, x: 16, o: 0.8 },
  { left: '47%', size: 7, delay: 6.5, dur: 16, x: -28, o: 0.6 },
  { left: '58%', size: 4, delay: 1.2, dur: 14, x: 22, o: 0.75 },
  { left: '69%', size: 6, delay: 8.0, dur: 17, x: -14, o: 0.7 },
  { left: '80%', size: 5, delay: 3.4, dur: 13, x: 20, o: 0.85 },
  { left: '90%', size: 4, delay: 5.8, dur: 15, x: -22, o: 0.6 },
];

export function Embers() {
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {EMBERS.map((e, i) => (
        <span
          key={i}
          style={{
            position: 'absolute', bottom: 40, left: e.left,
            width: e.size, height: e.size, borderRadius: '50%',
            background: 'var(--ember)', boxShadow: '0 0 8px 1px var(--ember)', opacity: 0,
            ['--ember-x' as string]: `${e.x}px`,
            ['--ember-o' as string]: e.o,
            animation: `float-up ${e.dur}s ease-in-out ${e.delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Ambient page backdrop — a few soft, filled organic blobs that bleed into the
 * background on every page. Deliberately low-contrast (blurred, faint) so they
 * read as an intentional atmosphere, not decoration that competes with content.
 * Fixed to the viewport, behind everything, pointer-events-none.
 */
const BLOB_A = 'M48,-57C61,-46,68,-28,71,-9C74,10,72,31,61,45C50,59,30,66,9,70C-12,74,-34,75,-50,65C-66,55,-76,34,-78,13C-80,-8,-74,-30,-61,-45C-48,-60,-28,-68,-7,-69C14,-70,28,-68,48,-57Z';
const BLOB_B = 'M52,-60C65,-49,71,-30,73,-11C75,8,73,28,63,43C53,58,35,68,15,72C-5,76,-27,74,-45,64C-63,54,-77,36,-80,16C-83,-4,-75,-26,-62,-42C-49,-58,-31,-68,-11,-70C9,-72,29,-71,52,-60Z';

function Blob({ d, fill, style }: { d: string; fill: string; style: CSSProperties }) {
  return (
    <svg viewBox="-100 -100 200 200" aria-hidden style={{ position: 'absolute', ...style }}>
      <path d={d} fill={fill} />
    </svg>
  );
}

export function PageBackdrop() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
      <Blob d={BLOB_A} fill="var(--blob-1)" style={{ top: -180, right: -120, width: 560, height: 560, filter: 'blur(48px)', animation: 'drift-a 38s ease-in-out infinite' }} />
      <Blob d={BLOB_B} fill="var(--blob-2)" style={{ bottom: -200, left: '16%', width: 520, height: 520, filter: 'blur(54px)', transform: 'rotate(40deg)', animation: 'drift-b 46s ease-in-out infinite' }} />
      <Blob d={BLOB_B} fill="var(--blob-1)" style={{ top: '44%', right: -80, width: 380, height: 380, filter: 'blur(44px)', transform: 'rotate(-20deg)', animation: 'drift-a 32s ease-in-out infinite reverse' }} />
    </div>
  );
}

/**
 * Empty-state illustration: a lantern radiating concentric light rings over an
 * empty horizon. `dim` softens the glow for "nothing here yet" states.
 */
export function EmptyLantern({ size = 116, dim = false }: { size?: number; dim?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden>
      {/* radiating rings */}
      {[26, 38, 50].map((r, i) => (
        <circle key={r} cx="60" cy="52" r={r} fill="none" stroke="var(--accent)" strokeOpacity={(dim ? 0.10 : 0.18) - i * 0.04} strokeWidth="1.2" strokeDasharray={i === 2 ? '3 6' : undefined} />
      ))}
      {/* horizon line */}
      <line x1="18" y1="96" x2="102" y2="96" stroke="var(--border)" strokeWidth="1.4" strokeLinecap="round" />
      {/* lantern, scaled + centered around (60,52) */}
      <g transform="translate(60 52) scale(2.7) translate(-12 -12)">
        <path d="M9.4 4.1c0-1.43 1.16-2.6 2.6-2.6s2.6 1.17 2.6 2.6" stroke="var(--text-faint)" strokeWidth="1.2" strokeLinecap="round" />
        <rect x="7.3" y="4.4" width="9.4" height="2.4" rx="1.2" fill="var(--text-faint)" />
        <path d="M8.1 7.4h7.8l-.62 9.0c-.05.74-.66 1.3-1.4 1.3H10.1c-.74 0-1.35-.56-1.4-1.3L8.1 7.4Z" stroke="var(--text-faint)" strokeWidth="1.2" strokeLinejoin="round" />
        <rect x="9.1" y="17.9" width="5.8" height="2.2" rx="1.1" fill="var(--text-faint)" />
        <circle cx="12" cy="11.9" r="2.5" fill="var(--accent)" opacity={dim ? 0.55 : 1} />
      </g>
    </svg>
  );
}
