'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/entities/session';
import { LoginForm } from '@/features/auth';

export function LoginPage() {
  const session = useSession();
  const router = useRouter();
  useEffect(() => {
    if (session.status === 'authenticated') router.replace('/');
  }, [session.status, router]);
  return <LoginForm />;
}
