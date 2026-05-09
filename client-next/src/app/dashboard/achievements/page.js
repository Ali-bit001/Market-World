'use client';

import { useContext, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Achievements from '@/views/Achievements';
import { AuthContext } from '@/context/auth-context';

export default function AchievementsPage() {
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

  return <Achievements />;
}
