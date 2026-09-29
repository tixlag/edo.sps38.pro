import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../lib/query-client';
import { useAuthBootstrap } from '../lib/auth-context';
import { AppShell } from './AppShell';

export function App() {
  const queryClient = React.useMemo(() => createQueryClient(), []);
  const status = useAuthBootstrap();
  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm">Загрузка…</div>;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
