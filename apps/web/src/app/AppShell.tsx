import * as React from 'react';
import { Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { AppSidebar } from '../components/AppSidebar';
import { AppHeader } from '../components/AppHeader';
import { useGetMe } from '@edo/api-client';
import { Button } from '@edo/ui';

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
  const profile = useGetMe();
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
        profile={profile.data}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <AppHeader crumb={crumbFor(pathname)} profile={profile.data} />
        {profile.isError && (
          <div role="alert" className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-7 py-3 text-sm">
            Не удалось загрузить ваш профиль ЛК.
            <Button variant="outline" size="sm" onClick={() => void profile.refetch()}>Повторить</Button>
          </div>
        )}
        {profile.data && !profile.data.fullName && (
          <div className="border-b border-[var(--border)] px-7 py-3 text-sm text-[var(--muted-foreground)]">
            Вход выполнен. Для этой учётной записи профиль в справочнике ЛК пока не найден.
          </div>
        )}
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
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
