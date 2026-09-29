import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createQueryClient } from '../lib/query-client';
import { useAuthBootstrap } from '../lib/auth-context';
import { router } from './router';

export function App() {
  const queryClient = React.useMemo(() => createQueryClient(), []);
  const status = useAuthBootstrap();
  if (status === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm">Загрузка…</div>;
  }
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
