'use client';
import clsx from 'clsx';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef } from 'react';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  }
>(function Button({ variant = 'primary', className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      {...rest}
      className={clsx(
        'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-brand text-white hover:bg-brand-dark',
        variant === 'secondary' && 'border border-[var(--line)] bg-[var(--card)] hover:bg-black/5',
        variant === 'danger' && 'bg-red-700 text-white hover:bg-red-800',
        variant === 'ghost' && 'hover:bg-black/5',
        className,
      )}
    />
  );
});

export const Card = ({ children, className }: { children: ReactNode; className?: string }) => (
  <section
    className={clsx('rounded-lg border border-[var(--line)] bg-[var(--card)] p-4', className)}
  >
    {children}
  </section>
);

export const Badge = ({
  children,
  tone = 'gray',
  ...rest
}: { children: ReactNode; tone?: 'gray' | 'blue' | 'green' | 'amber' | 'red' } & {
  'data-testid'?: string;
}) => (
  <span
    {...rest}
    className={clsx(
      'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
      tone === 'gray' && 'bg-black/10',
      tone === 'blue' && 'bg-blue-600/15 text-blue-700 dark:text-blue-300',
      tone === 'green' && 'bg-green-600/15 text-green-700 dark:text-green-300',
      tone === 'amber' && 'bg-amber-500/20 text-amber-800 dark:text-amber-300',
      tone === 'red' && 'bg-red-600/15 text-red-700 dark:text-red-300',
    )}
  >
    {children}
  </span>
);

type FieldProps = {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
  htmlFor: string;
};
/** A labelled control with its error right next to it (and wired for screen readers). */
export const Field = ({ label, error, hint, children, htmlFor }: FieldProps) => (
  <div className="mb-3">
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium">
      {label}
    </label>
    {children}
    {hint !== undefined && error === undefined ? (
      <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>
    ) : null}
    {error !== undefined ? (
      <p
        id={`${htmlFor}-error`}
        role="alert"
        data-testid={`error-${htmlFor}`}
        className="mt-1 text-xs text-red-600"
      >
        {error}
      </p>
    ) : null}
  </div>
);

const inputClass =
  'w-full rounded-md border border-[var(--line)] bg-[var(--card)] px-2 py-1.5 text-sm aria-[invalid=true]:border-red-600';

export const TextInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function TextInput({ invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true}
      aria-describedby={invalid === true && rest.id !== undefined ? `${rest.id}-error` : undefined}
      className={clsx(inputClass, className)}
      {...rest}
    />
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function TextArea({ invalid, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid === true}
      aria-describedby={invalid === true && rest.id !== undefined ? `${rest.id}-error` : undefined}
      className={clsx(inputClass, className)}
      {...rest}
    />
  );
});

export const Spinner = () => (
  <span
    role="status"
    aria-label="Loading"
    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
  />
);

export const ErrorNote = ({ children }: { children: ReactNode }) => (
  <p
    role="alert"
    className="rounded-md border border-red-600/40 bg-red-600/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
  >
    {children}
  </p>
);

export const PageTitle = ({ children }: { children: ReactNode }) => (
  <h1 className="mb-4 text-xl font-semibold">{children}</h1>
);
