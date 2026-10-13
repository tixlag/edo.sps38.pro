# Design System — Pencil as source of truth

Source file: `zabor.pen` (19 top-level screens).
Screens: Dashboard — ЕЗД (main, id YVyhb), Dashboard — Застряли, 5 dashboard drawers,
6 list pages (Застряли / Очередь проверки / Ждут подписи / Оформлено за период / Сроки действия / Повторные исправления),
Dashboard — Раскрытое меню, Подписание x3, Участники и роли, Шаблоны документов.

## Tokens (from .pen variables)

| Token | Value | Semantic usage |
|---|---|---|
| `color-bg` | #F4F6F8 | app background `--background` |
| `color-surface` | #FFFFFF | cards `--card` |
| `color-border` | #E5E7EB | `--border` |
| `color-text` | #171717 | `--foreground` |
| `color-muted` | #737373 | `--muted-foreground` |
| `color-primary` | #B31B1B | `--primary` (ЕЗД red, logo, active nav, danger) |
| `color-primary-soft` | #FBEAEA | `--primary-soft` (active nav bg) |
| `color-info` | #3B82F6 | `--info` |
| `color-info-soft` | #EAF2FF | `--info-soft` |
| `color-success` | #22A35A | `--success` |
| `color-success-soft` | #EAF8F0 | `--success-soft` |
| `color-accent` | #F59E0B | `--warning` (blocked/selected outline) |
| `color-accent-soft` | #FFF7E6 | `--warning-soft` |
| `color-purple` | #7C3AED | review states |
| `font-ui` | Inter | `--font-sans` |
| `font-data` | Geist Mono | numbers/KPI values |

See `apps/web/src/index.css` for the CSS variable mapping. Never hardcode hex in components.

## Layout

- Collapsed sidebar: 84px wide, white 88% fill, right 1px border, vertical, padding 22/14, nav items 52x52 radius 12, gap 8.
- Active nav: fill primary-soft, icon primary. Inactive: transparent, icon muted/dark.
- Expand control: 26x26 absolute at x57/y56, white, radius 8, border, shadow.
- Expanded sidebar: 360px overlay, radius 0, shadow 10px blur 30, sections Работа / Конфигурация / Контроль, items 46px radius 11-12.
- TopBar: 72px, white, bottom border, padding 0/28, breadcrumb 14px (root muted, current semibold), actions: object selector + date + search/bell 40x40 radius 10 + avatar 40 primary.
- Content: bg, vertical gap 20, padding 26/28/28/28.
- PageHeader: title 22px bold tight, subtitle 14 muted; actions gap 10.
- KPI cards: row height 142, gap 14, card radius 13, border, shadow 0/3/12, padding 16, label 13 semibold muted, value 28 Geist Mono bold, hint 11 info. Selected card: 2px accent stroke.
- Analytics row: 300px, gap 20. Left chart card 1100px, right stages card fill.
- Cards: radius 13, padding 20, header/content pattern.
- Toast: 360x68 absolute bottom-right, dark #18201C radius 12, icon box 36 green tint.

## Repeating components (implemented in packages/ui + apps/web)

AppSidebar (collapsed/expanded), AppHeader/TopBar, PageHeader, MetricCard, StatusBadge/Badge, EmptyState, DataTable (TanStack Table wrapper), ActivityItem, TaskRow, KpiCard.

## Navigation (from expanded menu)

Работа: Дашборд, Мои задачи (badge 12), Проверка документов (badge 11), Оформление, Подписание (badge 4), Работники.
Конфигурация: Участники, Путь оформления, Наборы требований, Шаблоны документов, Справочники, Настройки.
Контроль: Журнал действий, Интеграции, Личные дела.

## Dashboard blocks (first slice scope)

KPI x6, Оформлено за неделю (Пн..Вс bars), Работники по этапам (donut + 6 legend items), Последние действия (5 rows), Заблокированы на шаге, Мои задачи на сегодня, Sync toast (1С ERP).
