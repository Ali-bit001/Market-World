'use client';

import { useContext, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Landing from '@/views/Landing';
import { AuthContext } from '@/context/auth-context';

export default function HomePage() {
  const { user, loading } = useContext(AuthContext);
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (user) {
      router.replace(user.current_world_id ? '/dashboard' : '/worlds');
    }
  }, [loading, user, router]);

  if (loading || user) {
    return null;
  }

  return <Landing />;
}
