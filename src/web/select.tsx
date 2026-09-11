import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  label?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

const encode = (value: string) => `choice:${value}`;

function adjacentControl(trigger: HTMLButtonElement, direction: number) {
  const dialog = trigger.closest('dialog');
  const scope = dialog ?? document.body;
  const controls = [...scope.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert], [aria-hidden="true"], .select-content') && control.getClientRects().length > 0);
  const index = controls.indexOf(trigger);
  if (index < 0) return trigger;
  const nextIndex = index + direction;
  return controls[nextIndex] ?? (dialog ? controls[(nextIndex + controls.length) % controls.length] : trigger);
}

export function Select({ value, onValueChange, options, label, placeholder = '请选择', required = false, disabled = false, id, 'aria-describedby': describedBy }: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? generatedId;
  const errorId = `${triggerId}-error`;
  const trigger = useRef<HTMLButtonElement>(null);
  const tabDirection = useRef(0);
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const selected = options.find(option => option.value === value);
  const validSelection = selected && !selected.disabled && value !== '';
  const descriptionIds = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  useLayoutEffect(() => {
    setPortalContainer(trigger.current?.closest('dialog') ?? document.body);
  }, []);
  useEffect(() => { setInvalid(false); }, [value]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <span className="select-control">
    <SelectPrimitive.Root value={selected ? encode(value) : ''} open={open} onOpenChange={setOpen} disabled={disabled}
      onValueChange={next => { setInvalid(false); onValueChange(next.startsWith('choice:') ? next.slice(7) : ''); }}>
      <SelectPrimitive.Trigger ref={trigger} id={triggerId} className="select-trigger" aria-label={label} aria-describedby={descriptionIds}
        aria-required={required || undefined} aria-invalid={invalid || undefined} data-placeholder={!selected || (required && value === '') ? '' : undefined}>
        <SelectPrimitive.Value placeholder={placeholder}>{selected?.label ?? placeholder}</SelectPrimitive.Value>
        <SelectPrimitive.Icon className="select-chevron"><ChevronDown size={16} /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {portalContainer && <SelectPrimitive.Portal container={portalContainer}>
        <SelectPrimitive.Content className="select-content" position="popper" side="bottom" align="start" sideOffset={6}
          collisionBoundary={portalContainer instanceof HTMLDialogElement ? portalContainer : undefined}
          collisionPadding={8} avoidCollisions sticky="always" hideWhenDetached
          onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}
          onKeyDown={event => {
            if (event.key === 'Tab') {
              event.preventDefault();
              tabDirection.current = event.shiftKey ? -1 : 1;
              setOpen(false);
            }
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (trigger.current) {
              const target = tabDirection.current ? adjacentControl(trigger.current, tabDirection.current) : trigger.current;
              target?.focus({ preventScroll: true });
              if (tabDirection.current) target?.scrollIntoView({ block: 'nearest' });
            }
            tabDirection.current = 0;
          }}>
          <SelectPrimitive.ScrollUpButton className="select-scroll-button"><ChevronUp size={15} /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map(option => <SelectPrimitive.Item key={option.value} value={encode(option.value)} textValue={option.label} disabled={option.disabled} className="select-item">
              <span className="select-item-copy"><SelectPrimitive.ItemText className="select-item-text">{option.label}</SelectPrimitive.ItemText>
                {option.description && <span className="select-item-description">{option.description}</span>}
              </span>
              <SelectPrimitive.ItemIndicator className="select-item-indicator"><Check size={16} /></SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
            {!options.length && <div className="select-empty">暂无可选项</div>}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll-button"><ChevronDown size={15} /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>}
    </SelectPrimitive.Root>
    {required && <select className="select-validation" aria-hidden="true" tabIndex={-1} required disabled={disabled}
      value={validSelection ? value : ''} onChange={() => undefined}
      style={{ position: 'absolute', width: 1, height: 1, margin: 0, padding: 0, border: 0, opacity: 0, pointerEvents: 'none', insetInlineStart: 0, top: 0 }}
      onInvalid={event => {
        event.preventDefault();
        setInvalid(true);
        const firstInvalid = event.currentTarget.form?.querySelector('input:invalid, select:invalid, textarea:invalid');
        if (firstInvalid && firstInvalid !== event.currentTarget) return;
        trigger.current?.focus({ preventScroll: true });
        trigger.current?.scrollIntoView({ block: 'center' });
      }}>
      <option value="" />
      {options.filter(option => option.value !== '' && !option.disabled).map(option => <option value={option.value} key={option.value}>{option.label}</option>)}
    </select>}
    {invalid && <span className="select-error" id={errorId} aria-live="polite">{label ? `请选择${label}` : '请选择一个选项'}</span>}
  </span>;
}
