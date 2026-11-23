'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { loginInput } from '@helpdesk/shared';
import { login } from '@/entities/session';
import { isApiCallError } from '@/shared/api';
import { messageForCode, toFieldErrors } from '@/shared/lib';
import { Button, ErrorNote, Field, TextInput } from '@/shared/ui';

type Values = { email: string; password: string };

export function LoginForm() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(loginInput),
  });
  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await login(v.email, v.password);
      router.replace('/');
    } catch (e) {
      if (!isApiCallError(e)) return setFormError('Cannot reach the server.');
      const { fields, form } = toFieldErrors(e.body, ['email', 'password']);
      for (const f of fields) setError(f.field as keyof Values, { message: f.message });
      setFormError(form === null ? null : messageForCode(e.code, form));
    }
  });
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="mx-auto mt-16 max-w-sm rounded-lg border border-[var(--line)] bg-[var(--card)] p-6"
      aria-label="Sign in"
    >
      <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
      {formError !== null ? <ErrorNote>{formError}</ErrorNote> : null}
      <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
        <TextInput
          id="email"
          type="email"
          autoComplete="username"
          invalid={formState.errors.email !== undefined}
          {...register('email')}
        />
      </Field>
      <Field label="Password" htmlFor="password" error={formState.errors.password?.message}>
        <TextInput
          id="password"
          type="password"
          autoComplete="current-password"
          invalid={formState.errors.password !== undefined}
          {...register('password')}
        />
      </Field>
      <Button type="submit" disabled={formState.isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}
