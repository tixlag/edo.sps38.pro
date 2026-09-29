import * as React from 'react';
import { AppSidebar } from '../components/AppSidebar';
import { AppHeader } from '../components/AppHeader';
import { DashboardPage } from '../pages/DashboardPage';
import { EmployeesPage } from '../pages/EmployeesPage';
import { EmployeeDetailPage } from '../pages/EmployeeDetailPage';

type Route = '/' | '/employees' | '/employee' | '/tasks' | '/review' | '/onboarding' | '/signing' | '/participants' | '/settings';

const CRUMBS: Record<Route, string> = {
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

export function AppShell() {
  const [collapsed, setCollapsed] = React.useState(true);
  const [route, setRoute] = React.useState<Route>('/');
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);

  const navigate = (to: string) => {
    if (to.startsWith('/employees/')) {
      setEmployeeId(to.split('/').pop() ?? null);
      setRoute('/employee');
      return;
    }
    setRoute((to as Route) in CRUMBS ? (to as Route) : '/');
  };

  return (
    <div className="flex h-full">
      <AppSidebar
        collapsed={collapsed}
        active={route === '/employee' ? '/employees' : route}
        onToggle={() => setCollapsed((v) => !v)}
        onNavigate={navigate}
      />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <AppHeader crumb={CRUMBS[route]} />
        <main className="min-h-0 flex-1">
          {route === '/' && <DashboardPage />}
          {route === '/employees' && (
            <EmployeesPage onOpen={(id) => navigate(`/employees/${id}`)} />
          )}
          {route === '/employee' && employeeId && <EmployeeDetailPage id={employeeId} />}
          {!['/', '/employees', '/employee'].includes(route) && (
            <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
              Раздел «{CRUMBS[route]}» — следующий слайс (макеты Pencil готовы).
            </div>
          )}
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
