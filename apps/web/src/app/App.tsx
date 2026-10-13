import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createQueryClient } from '../lib/query-client';
import { AuthProvider, useAuthStatus } from '../lib/auth-context';
import { router } from './router';

function Shell() {
  const queryClient = React.useMemo(() => createQueryClient(), []);
  const status = useAuthStatus();
  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm">Загрузка…</div>;
  }
  // Never render the protected application shell as authorized when refresh
  // failed: network/5xx and 401/403 both land here as unauthenticated.
  if (status === 'unauthenticated') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
        <div>Требуется вход через LK</div>
        <div className="text-xs text-[var(--muted-foreground)]">
          Сессия не восстановлена (refresh неуспешен). Войдите через единый auth-service.
        </div>
      </div>
    );
  }
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
