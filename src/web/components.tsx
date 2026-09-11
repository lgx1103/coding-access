import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEventHandler, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Check, ChevronRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from './api.js';
import { statusLabel } from './ui-format.js';
import brandSymbol from './assets/brand-symbol.png';

export function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><img src={brandSymbol} alt="" /></span>;
}
export function Status({ value, label }: { value: string; label?: string }) {
  return <span className={`status status-${value}`}><i />{label ?? statusLabel(value)}</span>;
}
export function Button({ children, kind = 'primary', busy, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'quiet' | 'danger'; busy?: boolean }) {
  return <button {...props} disabled={props.disabled || busy} className={`button ${kind} ${className}`}>{busy && <LoaderCircle size={16} className="spin" />}{children}</button>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) ? children : null;
  const controlId = control?.props.id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const describedBy = [control?.props['aria-describedby'], hint ? hintId : undefined].filter(Boolean).join(' ') || undefined;
  return <div className="field"><label htmlFor={controlId}>{label}</label>{control ? cloneElement(control, { id: controlId, 'aria-describedby': describedBy }) : children}{hint && <small id={hintId}>{hint}</small>}</div>;
}
export function Empty({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty"><span className="empty-symbol"><ChevronRight size={22} /></span><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>;
}
export function Notice({ children, error = false, warning = false }: { children: ReactNode; error?: boolean; warning?: boolean }) {
  const Icon = warning && !error ? AlertTriangle : AlertCircle;
  return <div className={`notice ${error ? 'notice-error' : warning ? 'notice-warning' : ''}`} role={error ? 'alert' : 'status'} tabIndex={error ? -1 : undefined}><Icon size={17} aria-hidden="true" /><span>{children}</span></div>;
}
let openModalCount = 0;
let previousBodyOverflow = '';
let previousRootOverflow = '';

export function Modal({ title, subtitle, children, footer, onSubmit, onClose, wide = false }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const previousAlerts = useRef('');
  const [submissionAttempt, setSubmissionAttempt] = useState(0);
  const headingId = useId();
  const subtitleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openModalCount++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      previousRootOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    }
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.close();
      if (--openModalCount === 0) {
        document.body.style.overflow = previousBodyOverflow;
        document.documentElement.style.overflow = previousRootOverflow;
      }
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const alerts = [...(ref.current?.querySelectorAll<HTMLElement>('.modal-body [role="alert"]') ?? [])];
    const signature = JSON.stringify(alerts.map(alert => alert.textContent));
    if (signature === previousAlerts.current) return;
    previousAlerts.current = signature;
    const alert = alerts[0];
    if (alert) {
      alert.focus({ preventScroll: true });
      alert.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }, [children, submissionAttempt]);
  const content = <><div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}</>;
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={headingId} aria-describedby={subtitle ? subtitleId : undefined} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="modal-heading"><div><h2 id={headingId}>{title}</h2>{subtitle && <p id={subtitleId}>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="关闭窗口" onClick={onClose}><X size={20} /></button></div>
    {onSubmit ? <form className="modal-layout" onSubmit={e => { previousAlerts.current = ''; setSubmissionAttempt(attempt => attempt + 1); onSubmit(e); }} onInvalidCapture={e => {
      const input = e.target as HTMLElement;
      if (input !== e.currentTarget.querySelector('input:invalid, select:invalid, textarea:invalid')) return;
      let ancestor = input.parentElement;
      while (ancestor && ancestor !== ref.current) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      requestAnimationFrame(() => input.scrollIntoView({ block: 'center', behavior: 'instant' }));
    }}>{content}</form> : <div className="modal-layout">{content}</div>}
  </dialog>;
}
export function useData<T = any>(path: string, pollMs = 0) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const current = useRef(path); current.current = path;
  const sequence = useRef(0); const loadedPath = useRef('');
  const refresh = useCallback(async () => {
    const serial = ++sequence.current; const requested = path; setLoading(true); setError('');
    try { const value = await api<T>(requested); if (current.current === requested && serial === sequence.current) { loadedPath.current = requested; setData(value); } return true; }
    catch (e) { if (current.current === requested && serial === sequence.current) setError(e instanceof Error ? e.message : '加载失败'); return false; }
    finally { if (current.current === requested && serial === sequence.current) setLoading(false); }
  }, [path]);
  useEffect(() => { setData(null); void refresh(); return () => { sequence.current++; }; }, [refresh]);
  useEffect(() => {
    if (!pollMs) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await refresh();
      if (!stopped) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pollMs, refresh]);
  return { data: loadedPath.current === path ? data : null, error, loading, refresh };
}
export function Refresh({ onClick, busy, label = '刷新' }: { onClick: () => void; busy?: boolean; label?: string }) {
  return <button className="icon-button" onClick={onClick} disabled={busy} aria-label={label} title={label}><RefreshCw size={17} className={busy ? 'spin' : ''} /></button>;
}
export function Loading() { return <div className="loading" role="status"><LoaderCircle className="spin" size={21} /><span>正在读取公司资源…</span></div>; }
export function ConfirmAction({ path, label, detail, method = 'DELETE', onDone, initialConfirm = false }: { initialConfirm?: boolean; path: string; label: string; detail: string; method?: string; onDone: () => void }) {
  const [confirm, setConfirm] = useState(initialConfirm); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <div className="danger-action">{error && <Notice error>{error}</Notice>}{confirm ? <><p>{detail}</p><div className="heading-actions"><Button type="button" kind="secondary" onClick={() => setConfirm(false)}>取消</Button><Button type="button" kind="danger" busy={busy} onClick={() => { setBusy(true); void api(path, method).then(onDone).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>确认{label}</Button></div></> : <Button type="button" kind="quiet" onClick={() => setConfirm(true)}>{label}</Button>}</div>;
}
export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => { const timer = setTimeout(onClose, 5000); return () => clearTimeout(timer); }, [message, onClose]);
  return <div className="toast" role="status"><Check size={17} /><span>{message}</span><button aria-label="关闭提示" onClick={onClose}><X size={15} /></button></div>;
}
