import { Bell, Search } from 'lucide-react';
import type { MeResponseDto } from '@edo/api-client';
import { profileLabel, profileInitials } from '../lib/profile';

export function AppHeader({ crumb, profile }: { crumb: string; profile?: MeResponseDto }) {
  const name = profileLabel(profile);
  const scope = profile?.locationScope;
  const locationLabel = !scope ? 'Область доступа…' : scope.all ? 'Все объекты' : `Доступно объектов: ${scope.locationIds.length}`;
  return (
    <header className="flex h-[72px] w-full items-center justify-between border-b border-[var(--border)] bg-white px-7">
      <nav className="flex min-w-0 items-center gap-[9px] text-sm">
        <span className="hidden text-[var(--muted-foreground)] md:inline">Личный кабинет</span>
        <span className="hidden text-[var(--crumb)] md:inline">/</span>
        <span className="truncate font-semibold">{crumb}</span>
      </nav>
      <div className="flex items-center gap-3">
        <span className="hidden items-center gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-[14px] py-[10px] text-[13px] font-semibold lg:flex">
          {locationLabel}
        </span>
        <span className="hidden rounded-[10px] bg-[var(--muted)] px-[14px] py-[10px] text-[13px] md:inline">
          {new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date())}
        </span>
        <button
          aria-label="Поиск"
          disabled title="Поиск пока недоступен"
          className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)]"
        >
          <Search size={18} />
        </button>
        <button
          aria-label="Уведомления"
          disabled title="Уведомления пока недоступны"
          className="relative flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)]"
        >
          <Bell size={18} />
        </button>
        <span className="hidden max-w-[260px] truncate text-sm font-semibold sm:inline" title={name}>{name}</span>
        <div title={name} aria-label={name} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-bold text-white">
          {profileInitials(profile)}
        </div>
      </div>
    </header>
  );
}
