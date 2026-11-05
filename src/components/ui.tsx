import { type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react'
import { RECIPIENT_LABELS, type RecipientState, STATUS_LABELS, type CampaignStatus } from '../lib/types'

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-800 text-white hover:bg-brand-900 disabled:bg-stone-300',
  secondary: 'bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-100 disabled:text-stone-400',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-stone-300',
  ghost: 'text-stone-700 hover:bg-stone-200/70 disabled:text-stone-400',
}

export function Button({
  variant = 'secondary',
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
    >
      {busy && <Spinner className="size-4" />}
      {children}
    </button>
  )
}

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-lg bg-white ring-1 ring-stone-200', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 px-4 py-3 sm:px-5">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-stone-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-stone-800">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-stone-500">{hint}</p>}
      {error && (
        <p className="text-xs font-medium text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

const inputCls =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm ring-1 ring-stone-300 placeholder:text-stone-400 focus:ring-2 focus:ring-brand-600 focus:outline-none disabled:bg-stone-100 disabled:text-stone-500 aria-invalid:ring-red-500'

export function Input(props: ComponentProps<'input'>) {
  return <input {...props} className={cx(inputCls, props.className)} />
}

export function Textarea(props: ComponentProps<'textarea'>) {
  return <textarea {...props} className={cx(inputCls, 'font-mono leading-relaxed', props.className)} />
}

export function Select(props: ComponentProps<'select'>) {
  return <select {...props} className={cx(inputCls, 'pr-8', props.className)} />
}

export function Checkbox({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} type="checkbox" {...props} className="mt-0.5 size-4 shrink-0 rounded border-stone-300 accent-brand-800" />
      <label htmlFor={id} className="text-sm text-stone-800">
        {label}
      </label>
    </div>
  )
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'
const TONES: Record<Tone, string> = {
  neutral: 'bg-stone-100 text-stone-700 ring-stone-300',
  green: 'bg-green-50 text-green-800 ring-green-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-300',
  red: 'bg-red-50 text-red-800 ring-red-300',
  blue: 'bg-sky-50 text-sky-800 ring-sky-300',
  violet: 'bg-violet-50 text-violet-800 ring-violet-300',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', TONES[tone])}>{children}</span>
}

const STATUS_TONE: Record<CampaignStatus, Tone> = {
  draft: 'neutral',
  scheduled: 'blue',
  processing: 'violet',
  paused: 'amber',
  completed: 'green',
  cancelled: 'red',
}
export function StatusBadge({ status }: { status: CampaignStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Badge>
}

const RECIPIENT_TONE: Record<RecipientState, Tone> = {
  queued: 'neutral',
  processing: 'violet',
  accepted_by_smtp: 'green',
  temporary_failure: 'amber',
  permanent_failure: 'red',
  skipped_unsubscribed: 'neutral',
  cancelled: 'neutral',
  unknown_outcome: 'amber',
}
export function RecipientBadge({ state }: { state: RecipientState }) {
  return <Badge tone={RECIPIENT_TONE[state]}>{RECIPIENT_LABELS[state]}</Badge>
}

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'error' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const cls = {
    info: 'bg-sky-50 text-sky-900 ring-sky-200',
    warning: 'bg-amber-50 text-amber-900 ring-amber-200',
    error: 'bg-red-50 text-red-900 ring-red-200',
    success: 'bg-green-50 text-green-900 ring-green-200',
  }[tone]
  return (
    <div className={cx('rounded-md px-4 py-3 text-sm ring-1', cls)} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cx(Boolean(title) && 'mt-1', 'space-y-1')}>{children}</div>}
    </div>
  )
}

export function Loading({ label = 'Načítava sa…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-10 text-sm text-stone-600" role="status" aria-live="polite">
      <Spinner /> {label}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 px-6 py-10 text-center">
      <p className="font-medium text-stone-800">{title}</p>
      {children && <div className="mt-2 text-sm text-stone-600">{children}</div>}
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg p-0 shadow-xl ring-1 ring-stone-200 backdrop:bg-stone-900/40"
    >
      {open && (
        <div>
          <header className="border-b border-stone-200 px-5 py-4">
            <h2 className="text-lg font-semibold">{title}</h2>
          </header>
          <div className="space-y-4 px-5 py-4 text-sm">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-stone-200 bg-stone-50 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg bg-white px-4 py-3 ring-1 ring-stone-200">
      <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-stone-500">{hint}</p>}
    </div>
  )
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx('px-3 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-stone-500 uppercase', className)}>{children}</th>
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx('px-3 py-2.5 align-top', className)}>{children}</td>
}
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="min-w-full divide-y divide-stone-200 text-sm">{children}</table>
    </div>
  )
}
