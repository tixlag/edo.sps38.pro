import * as React from 'react';
import { Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { AppSidebar } from '../components/AppSidebar';
import { AppHeader } from '../components/AppHeader';

const CRUMBS: Record<string, string> = {
  '/': 'Дашборд',
  '/employees': 'Работники',
  '/employee': 'Карточка работника',
  '/tasks': 'Мои задачи',
  '/review': 'Проверка документов',
  '/onboarding': 'Оформление',
  '/signing': 'Подписание',
  '/participants': 'Участники',
  '/settings': 'Настройки',
};

function crumbFor(pathname: string): string {
  if (pathname.startsWith('/employees/')) return CRUMBS['/employee'] ?? '';
  return CRUMBS[pathname] ?? CRUMBS['/'] ?? '';
}

function activeFor(pathname: string): string {
  if (pathname.startsWith('/employees')) return '/employees';
  return pathname;
}

/** Layout shell: real URL routing via TanStack Router (back/forward + deep links work). */
export function AppShell() {
  const [collapsed, setCollapsed] = React.useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const pathname = location.pathname;

  const go = (to: string) => {
    void navigate({ to });
  };

  return (
    <div className="flex h-full">
      <AppSidebar
        collapsed={collapsed}
        active={activeFor(pathname)}
        onToggle={() => setCollapsed((v) => !v)}
        onNavigate={go}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <AppHeader crumb={crumbFor(pathname)} />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
      <div className="pointer-events-none fixed bottom-6 right-6 flex w-[360px] items-center gap-3 rounded-[12px] bg-[var(--toast-bg)] p-[12px_14px] text-white shadow-[0_5px_18px_rgba(0,0,0,0.19)]">
        <span className="flex h-9 w-9 items-center justify-center rounded-[9px] bg-[var(--success-tint)] text-[var(--success-bright)]">
          ✓
        </span>
        <span className="flex flex-col gap-[3px]">
          <span className="text-[12px] font-bold">Данные синхронизированы</span>
          <span className="text-[10px] text-[var(--toast-sub)]">1С ERP · 2 мин назад</span>
        </span>
      </div>
    </div>
  );
}

export function useEmployeeRouteId(): string | null {
  try {
    const params = useParams({ strict: false }) as { employeeId?: string };
    return params.employeeId ?? null;
  } catch {
    return null;
  }
}
