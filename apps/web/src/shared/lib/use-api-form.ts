'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type Resolver,
  type UseFormReturn,
} from 'react-hook-form';
import type { ZodTypeAny } from 'zod';
import { toFieldErrors, messageForCode } from './api-errors';

type ApiFailure = { body?: unknown; code?: string; message?: string };

/** React Hook Form + the shared zod schema; server-side field errors land next to the right input. */
export const useApiForm = <T extends FieldValues>(
  schema: ZodTypeAny,
  defaults: DefaultValues<T>,
  submit: (values: T) => Promise<void>,
  fields: readonly string[],
): { form: UseFormReturn<T>; onSubmit: () => Promise<void>; formError: string | null } => {
  const form = useForm<T>({
    resolver: zodResolver(schema as never) as unknown as Resolver<T>,
    defaultValues: defaults,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await submit(values);
    } catch (e) {
      const f = e as ApiFailure;
      const mapped = toFieldErrors(f.body, fields);
      for (const x of mapped.fields) form.setError(x.field as Path<T>, { message: x.message });
      setFormError(mapped.form === null ? null : messageForCode(f.code ?? '', mapped.form));
    }
  });
  return { form, onSubmit: () => onSubmit(), formError };
};
