import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ConflictError, TombstonedError } from '../lib/data';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M8 9l8 14 8-14" fill="none" stroke="var(--accent-ink)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="brand" aria-label="Vkin, The Meeting Copilot, home">
      <Logo />
      <span>
        Vkin<span className="tag"> — The Meeting Copilot</span>
      </span>
    </Link>
  );
}

export function Notice({ kind = 'info', children, role }: { kind?: 'info' | 'ok' | 'warn' | 'error'; children: ReactNode; role?: string }) {
  return (
    <div className={`notice ${kind}`} role={role ?? (kind === 'error' ? 'alert' : 'status')}>
      {children}
    </div>
  );
}

/** Shows an operation error. A rev conflict gets the "changed elsewhere" message and a reload button. */
export function ErrorNotice({ error, onReload }: { error: Error | null; onReload?: () => void }) {
  if (!error) return null;
  if (error instanceof ConflictError) {
    return (
      <Notice kind="error">
        <p>
          <strong>Changed elsewhere, reload.</strong> This item was changed on another device or in the desktop app after you opened
          it, so your change was not saved.
        </p>
        {onReload && (
          <button type="button" className="btn small" onClick={onReload}>
            Reload latest version
          </button>
        )}
      </Notice>
    );
  }
  if (error instanceof TombstonedError) {
    return (
      <Notice kind="error">
        <p>{error.message}</p>
        {onReload && (
          <button type="button" className="btn small" onClick={onReload}>
            Reload
          </button>
        )}
      </Notice>
    );
  }
  return <Notice kind="error">{error.message}</Notice>;
}

interface FieldBase {
  label: string;
  hint?: ReactNode;
}

export function TextField({
  label, hint, value, onChange, maxLength, required, type = 'text', autoComplete, inputMode, className, placeholder,
}: FieldBase & {
  value: string; onChange: (v: string) => void; maxLength?: number; required?: boolean;
  type?: 'text' | 'email' | 'date'; autoComplete?: string; inputMode?: 'numeric' | 'text' | 'email'; className?: string; placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      <input
        id={id} type={type} value={value} maxLength={maxLength} required={required} autoComplete={autoComplete}
        inputMode={inputMode} className={className} placeholder={placeholder} aria-describedby={hint ? `${id}-h` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="hint" id={`${id}-h`}>{hint}</p>}
    </div>
  );
}

export function TextArea({
  label, hint, value, onChange, maxLength, rows, tall, placeholder,
}: FieldBase & { value: string; onChange: (v: string) => void; maxLength?: number; rows?: number; tall?: boolean; placeholder?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id} value={value} maxLength={maxLength} rows={rows} placeholder={placeholder} className={tall ? 'tall' : undefined}
        aria-describedby={`${id}-h`} onChange={(e) => onChange(e.target.value)}
      />
      <p className="hint" id={`${id}-h`}>
        {hint}
        {hint && maxLength ? ' ' : ''}
        {maxLength ? `${value.length.toLocaleString()} / ${maxLength.toLocaleString()} characters.` : ''}
      </p>
    </div>
  );
}

export function SelectField<T extends string>({
  label, hint, value, onChange, options,
}: FieldBase & { value: T; onChange: (v: T) => void; options: readonly { value: T; label: string }[] }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} aria-describedby={hint ? `${id}-h` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <p className="hint" id={`${id}-h`}>{hint}</p>}
    </div>
  );
}

export function Check({
  label, hint, checked, onChange, disabled,
}: FieldBase & { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-h` : undefined} />
      <div>
        <label htmlFor={id}>{label}</label>
        {hint && <p className="hint" id={`${id}-h`}>{hint}</p>}
      </div>
    </div>
  );
}

/** Two-step destructive button: the first click asks, the second one does it. */
export function ConfirmButton({
  label, question, confirmLabel, onConfirm, disabled, small = true, solidLabel,
}: {
  label: string; question: string; confirmLabel: string; onConfirm: () => void | Promise<void>; disabled?: boolean; small?: boolean; solidLabel?: string;
}) {
  const [asking, setAsking] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) firstRef.current?.focus();
  }, [asking]);
  if (!asking) {
    return (
      <button type="button" className={`btn danger${small ? ' small' : ''}`} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm-bar" role="group" aria-label={question}>
      <span>{question}</span>
      <button
        ref={firstRef} type="button" className="btn danger solid small" disabled={disabled}
        onClick={async () => { await onConfirm(); setAsking(false); }}
      >
        {solidLabel ?? confirmLabel}
      </button>
      <button type="button" className="btn small" onClick={() => setAsking(false)}>Cancel</button>
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <p className="muted" role="status">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
