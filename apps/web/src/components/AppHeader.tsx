import { Bell, Search } from 'lucide-react';

export function AppHeader({ crumb }: { crumb: string }) {
  return (
    <header className="flex h-[72px] w-full items-center justify-between border-b border-[var(--border)] bg-white px-7">
      <nav className="flex items-center gap-[9px] text-sm">
        <span className="text-[var(--muted-foreground)]">Личный кабинет</span>
        <span className="text-[var(--crumb)]">/</span>
        <span className="font-semibold">{crumb}</span>
      </nav>
      <div className="flex items-center gap-3">
        <button className="flex items-center gap-2 rounded-[10px] border border-[var(--border)] bg-white px-[14px] py-[10px] text-[13px] font-semibold">
          Объект: Стройка-12
        </button>
        <span className="rounded-[10px] bg-[var(--muted)] px-[14px] py-[10px] text-[13px]">
          29 сен 2026
        </span>
        <button
          aria-label="Поиск"
          className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)]"
        >
          <Search size={18} />
        </button>
        <button
          aria-label="Уведомления"
          className="relative flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--muted)]"
        >
          <Bell size={18} />
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold text-white">
            5
          </span>
        </button>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-bold text-white">
          М
        </div>
      </div>
    </header>
  );
}
