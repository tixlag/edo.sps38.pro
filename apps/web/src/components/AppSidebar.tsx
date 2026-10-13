import * as React from 'react';
import {
  LayoutDashboard,
  ClipboardCheck,
  FileCheck2,
  Route,
  PenLine,
  Users,
  Settings,
  PanelLeftOpen,
  PanelLeftClose,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@edo/ui';
import type { MeResponseDto } from '@edo/api-client';
import { profileLabel, profileInitials } from '../lib/profile';

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  to: string;
}

export const WORK_NAV: NavItem[] = [
  { key: 'dashboard', label: 'Дашборд', icon: LayoutDashboard, to: '/' },
  { key: 'tasks', label: 'Мои задачи', icon: ClipboardCheck, to: '/tasks' },
  { key: 'review', label: 'Проверка документов', icon: FileCheck2, to: '/review' },
  { key: 'onboarding', label: 'Оформление', icon: Route, to: '/onboarding' },
  { key: 'signing', label: 'Подписание', icon: PenLine, to: '/signing' },
  { key: 'employees', label: 'Работники', icon: Users, to: '/employees' },
];

export const CONFIG_NAV: NavItem[] = [
  { key: 'participants', label: 'Участники', icon: Users, to: '/participants' },
  { key: 'settings', label: 'Настройки', icon: Settings, to: '/settings' },
];

const CONTROL_SECTIONS = [
  { title: 'Работа', items: WORK_NAV },
  { title: 'Конфигурация', items: CONFIG_NAV },
];

export function AppSidebar({
  collapsed,
  active,
  onToggle,
  onNavigate,
  profile,
}: {
  collapsed: boolean;
  active: string;
  onToggle: () => void;
  onNavigate: (to: string) => void;
  profile?: MeResponseDto;
}) {
  const name = profileLabel(profile);
  if (collapsed) {
    const all = [...WORK_NAV, ...CONFIG_NAV];
    return (
      <aside className="relative flex h-full w-[84px] flex-col items-center justify-between border-r border-[var(--border)] bg-[var(--sidebar)] px-[14px] py-[22px]">
        <div className="flex w-full flex-col items-center gap-[22px]">
          <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-[var(--primary)] text-[13px] font-bold text-white">
            ЕЗД
          </div>
          <nav className="flex w-full flex-col items-center gap-2">
            {all.slice(0, 8).map((item) => {
              const Icon = item.icon;
              const isActive = active === item.to || (item.to === '/' && active === '/');
              return (
                <button
                  key={item.key}
                  title={item.label}
                  onClick={() => onNavigate(item.to)}
                  className={cn(
                    'relative flex h-[52px] w-[52px] items-center justify-center rounded-[12px] transition-colors',
                    isActive ? 'bg-[var(--primary-soft)]' : 'hover:bg-[var(--muted)]',
                  )}
                >
                  <Icon size={22} color={isActive ? 'var(--primary)' : 'var(--foreground)'} />
                  {typeof item.badge === 'number' && (
                    <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold text-white">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
        <div className="flex flex-col items-center gap-3">
          <div title={name} aria-label={name} className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-[var(--avatar)] text-[13px] font-bold">
            {profileInitials(profile)}
          </div>
        </div>
        <button
          aria-label="Развернуть меню"
          onClick={onToggle}
          className="absolute -right-[13px] top-[56px] flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-[var(--border)] bg-white shadow-[0_2px_6px_rgba(15,23,42,0.09)]"
        >
          <PanelLeftOpen size={15} color="var(--primary)" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="absolute left-0 top-0 z-30 flex h-full w-[360px] flex-col justify-between border-r border-[var(--border)] bg-white/95 px-[18px] py-[22px] shadow-[10px_0_30px_rgba(15,23,42,0.14)]">
      <div className="flex flex-col gap-[22px] overflow-y-auto">
        <div className="flex h-[52px] items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-[var(--primary)] text-[13px] font-bold text-white">
              ЕЗД
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold">ЕЗД</span>
              <span className="text-xs text-[var(--muted-foreground)]">Оформление сотрудников</span>
            </div>
          </div>
          <button
            aria-label="Свернуть меню"
            onClick={onToggle}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border border-[var(--border)] bg-white"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        {CONTROL_SECTIONS.map((section) => (
          <div key={section.title} className="flex flex-col gap-1">
            <div className="px-[14px] pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              {section.title}
            </div>
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.to;
              return (
                <button
                  key={item.key}
                  onClick={() => onNavigate(item.to)}
                  className={cn(
                    'flex h-[46px] w-full items-center justify-between rounded-[12px] px-[14px] text-sm font-semibold',
                    isActive
                      ? 'bg-[var(--primary-soft)] text-[var(--foreground)]'
                      : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                  )}
                >
                  <span className="flex items-center gap-3">
                    <Icon size={20} color={isActive ? 'var(--primary)' : 'currentColor'} />
                    {item.label}
                  </span>
                  {typeof item.badge === 'number' && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1.5 text-[10px] font-bold text-white">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
        <div className="flex items-center gap-3 px-2">
          <div title={name} className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] text-[13px] font-bold">
            {profileInitials(profile)}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold" title={name}>{name}</span>
            <span className="truncate text-xs text-[var(--muted-foreground)]">{profile?.positionName ?? 'Учётная запись ЛК'}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
