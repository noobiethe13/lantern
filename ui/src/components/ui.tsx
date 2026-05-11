import {
  forwardRef, createContext, useContext, useState, useCallback,
  type ButtonHTMLAttributes, type InputHTMLAttributes,
  type TextareaHTMLAttributes, type ReactNode,
} from 'react';
import { Loader2, X } from 'lucide-react';

// ─── Button ───────────────────────────────────────────────────────────────────

type ButtonVariant = 'default' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md';

const buttonStyles: Record<ButtonVariant, React.CSSProperties> = {
  default: {
    background: 'var(--accent)',
    color: '#fff',
    border: '1px solid transparent',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'rgba(239,68,68,0.1)',
    color: 'var(--danger)',
    border: '1px solid rgba(239,68,68,0.2)',
  },
  outline: {
    background: 'transparent',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
};

const buttonSizes: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '4px 10px', fontSize: '12px', height: '28px', borderRadius: '6px' },
  md: { padding: '6px 14px', fontSize: '13px', height: '32px', borderRadius: '7px' },
};

const buttonHover: Record<ButtonVariant, React.CSSProperties> = {
  default: { background: 'var(--accent-hover)' },
  ghost: { background: 'var(--surface-2)', color: 'var(--text)' },
  danger: { background: 'rgba(239,68,68,0.18)' },
  outline: { background: 'var(--surface-2)' },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', loading, children, style, onMouseEnter, onMouseLeave, ...props }, ref) => {
    return (
      <button
        ref={ref}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontFamily: 'inherit',
          fontWeight: 500,
          cursor: props.disabled || loading ? 'not-allowed' : 'pointer',
          opacity: props.disabled || loading ? 0.5 : 1,
          transition: 'all 150ms ease-out',
          whiteSpace: 'nowrap',
          ...buttonStyles[variant],
          ...buttonSizes[size],
          ...style,
        }}
        onMouseEnter={e => {
          if (!props.disabled && !loading) {
            Object.assign((e.currentTarget as HTMLButtonElement).style, buttonHover[variant]);
          }
          onMouseEnter?.(e);
        }}
        onMouseLeave={e => {
          if (!props.disabled && !loading) {
            Object.assign((e.currentTarget as HTMLButtonElement).style, buttonStyles[variant]);
          }
          onMouseLeave?.(e);
        }}
        disabled={props.disabled || loading}
        {...props}
      >
        {loading && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';

// ─── Badge ────────────────────────────────────────────────────────────────────

type BadgeVariant = 'default' | 'indigo' | 'blue' | 'amber' | 'green' | 'red' | 'dim';

const badgeStyles: Record<BadgeVariant, React.CSSProperties> = {
  default: { background: '#27272a', color: '#a1a1aa' },
  indigo: { background: 'rgba(99,102,241,0.15)', color: '#818cf8' },
  blue: { background: 'rgba(59,130,246,0.15)', color: '#60a5fa' },
  amber: { background: 'rgba(245,158,11,0.15)', color: '#fbbf24' },
  green: { background: 'rgba(34,197,94,0.15)', color: '#4ade80' },
  red: { background: 'rgba(239,68,68,0.15)', color: '#f87171' },
  dim: { background: '#1c1c1e', color: '#52525b' },
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  style?: React.CSSProperties;
}

export function Badge({ variant = 'default', children, style }: BadgeProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: '4px',
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.01em',
        ...badgeStyles[variant],
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ─── Input ────────────────────────────────────────────────────────────────────

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ style, ...props }, ref) => (
    <input
      ref={ref}
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: '7px',
        color: 'var(--text)',
        fontFamily: 'inherit',
        fontSize: '13px',
        padding: '6px 10px',
        outline: 'none',
        transition: 'border-color 150ms ease-out',
        width: '100%',
        ...style,
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; props.onFocus?.(e); }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; props.onBlur?.(e); }}
      {...props}
    />
  )
);
Input.displayName = 'Input';

// ─── Textarea ─────────────────────────────────────────────────────────────────

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ style, ...props }, ref) => (
    <textarea
      ref={ref}
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: '7px',
        color: 'var(--text)',
        fontFamily: 'var(--mono)',
        fontSize: '12px',
        lineHeight: 1.65,
        padding: '10px 12px',
        outline: 'none',
        resize: 'vertical',
        transition: 'border-color 150ms ease-out',
        width: '100%',
        ...style,
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; props.onFocus?.(e); }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; props.onBlur?.(e); }}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';

// ─── Card ─────────────────────────────────────────────────────────────────────

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '10px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <Loader2
      size={size}
      style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }}
    />
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  style?: React.CSSProperties;
}

export function Skeleton({ width, height, style }: SkeletonProps) {
  return (
    <div
      style={{
        width: width ?? '100%',
        height: height ?? '14px',
        borderRadius: '4px',
        background: 'linear-gradient(90deg, var(--surface-2) 25%, var(--border) 50%, var(--surface-2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s infinite linear',
        ...style,
      }}
    />
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'info';
type ToastFn = (msg: string, type?: ToastType) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

interface ToastItem {
  id: number;
  msg: string;
  type: ToastType;
}

const toastBg: Record<ToastType, string> = {
  success: 'rgba(34,197,94,0.12)',
  error:   'rgba(239,68,68,0.12)',
  info:    'var(--surface)',
};
const toastBorder: Record<ToastType, string> = {
  success: 'rgba(34,197,94,0.3)',
  error:   'rgba(239,68,68,0.3)',
  info:    'var(--border)',
};
const toastColor: Record<ToastType, string> = {
  success: 'var(--success)',
  error:   'var(--danger)',
  info:    'var(--text)',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastFn>((msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  const dismiss = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          maxWidth: 380,
          pointerEvents: 'none',
        }}
      >
        {toasts.map(t => (
          <div
            key={t.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 12px',
              borderRadius: '9px',
              fontSize: '13px',
              lineHeight: 1.4,
              background: toastBg[t.type],
              border: `1px solid ${toastBorder[t.type]}`,
              color: toastColor[t.type],
              boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
              animation: 'toast-in 200ms ease-out',
              pointerEvents: 'all',
            }}
          >
            <span style={{ flex: 1 }}>{t.msg}</span>
            <button
              onClick={() => dismiss(t.id)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'inherit',
                opacity: 0.6,
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── global keyframe for spin ─────────────────────────────────────────────────
// Injected once via a style tag
if (typeof document !== 'undefined' && !document.getElementById('ui-keyframes')) {
  const style = document.createElement('style');
  style.id = 'ui-keyframes';
  style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`;
  document.head.appendChild(style);
}
