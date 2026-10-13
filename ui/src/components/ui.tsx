import {
  forwardRef, createContext, useContext, useState, useCallback,
  type ButtonHTMLAttributes, type InputHTMLAttributes,
  type TextareaHTMLAttributes, type ReactNode,
} from 'react';
import { Loader2, X } from 'lucide-react';

type ButtonVariant = 'default' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

// Hover / press / focus live in globals.css (.btn-*) rather than JS style
// mutation, so states compose with :disabled and :focus-visible and a caller's
// inline style can't get "stuck" after mouseleave.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', loading, children, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={['btn', `btn-${variant}`, `btn-${size}`, className].filter(Boolean).join(' ')}
      data-loading={loading || undefined}
      {...props}
      disabled={disabled || loading}
    >
      {loading && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
      {children}
    </button>
  )
);
Button.displayName = 'Button';

type BadgeTone = 'neutral' | 'accent' | 'blue' | 'violet' | 'success' | 'warning' | 'danger' | 'dim';

const badgeTone: Record<BadgeTone, string> = {
  neutral: 'var(--text-muted)',
  accent: 'var(--accent-text)',
  blue: 'var(--tone-blue)',
  violet: 'var(--tone-violet)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  dim: 'var(--text-faint)',
};

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  style?: React.CSSProperties;
}

export function Badge({ tone = 'neutral', children, style }: BadgeProps) {
  const color = badgeTone[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        fontSize: '11.5px',
        fontWeight: 550,
        letterSpacing: '0.005em',
        color,
        background: `color-mix(in oklch, ${color} 12%, transparent)`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={['field', className].filter(Boolean).join(' ')} {...props} />
  )
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={['field', 'field-area', className].filter(Boolean).join(' ')} {...props} />
  )
);
Textarea.displayName = 'Textarea';

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The one on/off control. Settings used to mix "On/Off" text buttons with the
 * Jobs refine switches; every boolean now reads the same way.
 */
export function Switch({ checked, onChange, disabled, label, busy }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
      className="switch"
    >
      <span className="switch-knob" />
    </button>
  );
}

/** Keyboard key hint — shortcuts are taught in place, next to what they do. */
export function Kbd({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <kbd className="kbd" style={style}>{children}</kbd>;
}

export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <Loader2
      size={size}
      style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }}
    />
  );
}

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  style?: React.CSSProperties;
}

export function Skeleton({ width, height, style }: SkeletonProps) {
  return (
    <div
      className="skeleton"
      style={{
        width: width ?? '100%',
        height: height ?? '14px',
        ...style,
      }}
    />
  );
}

type ToastType = 'success' | 'error' | 'info';
interface ToastOpts { action?: { label: string; onClick: () => void }; duration?: number }
type ToastFn = (msg: string, type?: ToastType, opts?: ToastOpts) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  msg: string;
  type: ToastType;
  action?: ToastOpts['action'];
  duration: number;
  leaving?: boolean;
}

const toastColor: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  info: 'var(--accent)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Two-step removal so the exit animation plays before the node unmounts.
  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 180);
  }, []);

  const toast = useCallback<ToastFn>((msg, type = 'info', opts) => {
    const id = Date.now() + Math.random();
    const duration = opts?.duration ?? (opts?.action ? 6000 : 4500);
    setToasts(prev => [...prev.slice(-3), { id, msg, type, action: opts?.action, duration }]);
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="toast" data-leaving={t.leaving || undefined}>
            <span aria-hidden className="toast-dot" style={{ background: toastColor[t.type] }} />
            <span style={{ flex: 1 }}>{t.msg}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
            {/* time-remaining hairline: tells you how long Undo stays available */}
            <span aria-hidden className="toast-timer" style={{ animationDuration: `${t.duration}ms` }} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
