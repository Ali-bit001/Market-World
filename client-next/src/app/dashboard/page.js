'use client';

import { useContext, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Dashboard from '@/views/Dashboard';
import { AuthContext } from '@/context/auth-context';

export default function DashboardPage() {
  const { user, loading } = useContext(AuthContext);
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/');
      return;
    }

    if (!user.current_world_id) {
      router.replace('/worlds');
    }
  }, [loading, user, router]);

  if (loading || !user || !user.current_world_id) {
    return null;
  }

  return <Dashboard mode="main" />;
}
