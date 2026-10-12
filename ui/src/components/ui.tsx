import {
  forwardRef, createContext, useContext, useState, useCallback,
  type ButtonHTMLAttributes, type InputHTMLAttributes,
  type TextareaHTMLAttributes, type ReactNode,
} from 'react';
import { Loader2, X } from 'lucide-react';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

type ButtonVariant = 'default' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md';

const buttonStyles: Record<ButtonVariant, React.CSSProperties> = {
  default: {
    background: 'var(--accent)',
    color: 'var(--accent-ink)',
    border: '1px solid transparent',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-muted)',
    border: '1px solid transparent',
  },
  danger: {
    background: 'transparent',
    color: 'var(--danger)',
    border: '1px solid color-mix(in oklch, var(--danger) 35%, transparent)',
  },
  outline: {
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
};

const buttonSizes: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '5px 11px', fontSize: '12.5px', height: '30px', borderRadius: 'var(--radius-sm)' },
  md: { padding: '7px 15px', fontSize: '13.5px', height: '34px', borderRadius: 'var(--radius-md)' },
};

const buttonHover: Record<ButtonVariant, React.CSSProperties> = {
  default: { background: 'var(--accent-hover)' },
  ghost: { background: 'var(--surface-2)', color: 'var(--text)' },
  danger: { background: 'color-mix(in oklch, var(--danger) 12%, transparent)' },
  outline: { background: 'var(--surface-2)' },
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'default', size = 'md', loading, children, style, disabled, onMouseEnter, onMouseLeave, ...props }, ref) => {
    return (
      <button
        ref={ref}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          fontFamily: 'inherit',
          fontWeight: 550,
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          opacity: disabled || loading ? 0.5 : 1,
          transition: `background 150ms ${EASE}, color 150ms ${EASE}, border-color 150ms ${EASE}`,
          whiteSpace: 'nowrap',
          ...buttonStyles[variant],
          ...buttonSizes[size],
          ...style,
        }}
        onMouseEnter={e => {
          if (!disabled && !loading) {
            Object.assign((e.currentTarget as HTMLButtonElement).style, buttonHover[variant]);
          }
          onMouseEnter?.(e);
        }}
        onMouseLeave={e => {
          if (!disabled && !loading) {
            Object.assign((e.currentTarget as HTMLButtonElement).style, buttonStyles[variant], style);
          }
          onMouseLeave?.(e);
        }}
        {...props}
        disabled={disabled || loading}
      >
        {loading && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
        {children}
      </button>
    );
  }
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

const fieldBase: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text)',
  fontFamily: 'inherit',
  fontSize: '13.5px',
  padding: '8px 11px',
  outline: 'none',
  transition: `border-color 150ms ${EASE}, box-shadow 150ms ${EASE}`,
  width: '100%',
};

function focusField(el: HTMLElement) {
  el.style.borderColor = 'var(--accent)';
  el.style.boxShadow = '0 0 0 3px var(--accent-ring)';
}
function blurField(el: HTMLElement) {
  el.style.borderColor = 'var(--border)';
  el.style.boxShadow = 'none';
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ style, ...props }, ref) => (
    <input
      ref={ref}
      style={{ ...fieldBase, ...style }}
      onFocus={e => { focusField(e.currentTarget); props.onFocus?.(e); }}
      onBlur={e => { blurField(e.currentTarget); props.onBlur?.(e); }}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ style, ...props }, ref) => (
    <textarea
      ref={ref}
      style={{
        ...fieldBase,
        fontFamily: 'var(--font-mono)',
        fontSize: '12.5px',
        lineHeight: 1.65,
        padding: '11px 13px',
        resize: 'vertical',
        ...style,
      }}
      onFocus={e => { focusField(e.currentTarget); props.onFocus?.(e); }}
      onBlur={e => { blurField(e.currentTarget); props.onBlur?.(e); }}
      {...props}
    />
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
      style={{
        width: width ?? '100%',
        height: height ?? '14px',
        borderRadius: 'var(--radius-sm)',
        background: 'linear-gradient(90deg, var(--surface-2) 25%, var(--border) 50%, var(--surface-2) 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s infinite linear',
        ...style,
      }}
    />
  );
}

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

const toastColor: Record<ToastType, string> = {
  success: 'var(--success)',
  error: 'var(--danger)',
  info: 'var(--text)',
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
        {toasts.map(t => {
          const color = toastColor[t.type];
          return (
            <div
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '11px 13px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                lineHeight: 1.45,
                background: 'var(--surface)',
                border: `1px solid ${t.type === 'info' ? 'var(--border)' : `color-mix(in oklch, ${color} 35%, var(--border))`}`,
                color: 'var(--text)',
                boxShadow: 'var(--shadow-md)',
                animation: `toast-in 200ms ${EASE}`,
                pointerEvents: 'all',
              }}
            >
              {t.type !== 'info' && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 6 }} />
              )}
              <span style={{ flex: 1 }}>{t.msg}</span>
              <button
                onClick={() => dismiss(t.id)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
                  padding: 0, display: 'flex', alignItems: 'center', flexShrink: 0, marginTop: 2,
                }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

if (typeof document !== 'undefined' && !document.getElementById('ui-keyframes')) {
  const style = document.createElement('style');
  style.id = 'ui-keyframes';
  style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}
