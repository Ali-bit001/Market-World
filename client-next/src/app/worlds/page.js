'use client';

import { useContext, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import WorldBrowser from '@/views/WorldBrowser';
import { AuthContext } from '@/context/auth-context';

export default function WorldsPage() {
  const { user, loading } = useContext(AuthContext);
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return null;
  }

  return <WorldBrowser />;
}
