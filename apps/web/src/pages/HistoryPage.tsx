import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { getListAuditLogsQueryKey, useGetMe, useListAuditLogs, type ListAuditLogsParams } from '@edo/api-client';
import { Button, Card, CardContent, EmptyState, PageHeader } from '@edo/ui';
import {
  auditActionLabel,
  auditEntityLabel,
  auditLogLink,
  hasAccessRule,
  type AuditLogItem,
} from '../lib/audit-types';

const PAGE_LIMIT = 50;

const ACTION_FILTERS = [
  { value: '', label: 'Все действия' },
  { value: 'DOCUMENT_APPROVED', label: 'Подтверждено' },
  { value: 'DOCUMENT_RETURNED', label: 'Возвращено' },
  { value: 'DOCUMENT_FIELDS_UPDATED', label: 'Поля исправлены' },
] as const;

const REVIEW_TABS = [
  { value: 'DOCUMENT_APPROVED', label: 'Подтвержденные' },
  { value: 'DOCUMENT_RETURNED', label: 'Отклоненные' },
] as const;

const FILTER_CONTROL =
  'rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]';
const TH = 'px-4 py-3 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]';
const TD = 'px-4 py-3';

function goToItem(navigate: ReturnType<typeof useNavigate>, item: AuditLogItem) {
  if (item.entityType === 'Document') {
    void navigate({ to: '/review/$documentId', params: { documentId: item.entityId } });
  } else if (item.entityType === 'Employee') {
    void navigate({ to: '/employees/$employeeId', params: { employeeId: item.entityId } });
  }
}

function ObjectCell({ item }: { item: AuditLogItem }) {
  const label = `${auditEntityLabel(item.entityType)} · ${item.entityId.slice(0, 8)}…`;
  const title = `${auditEntityLabel(item.entityType)} ${item.entityId}`;
  if (item.entityType === 'Document') {
    return (
      <Link
        to="/review/$documentId"
        params={{ documentId: item.entityId }}
        onClick={(e) => e.stopPropagation()}
        title={title}
        className="font-medium text-[var(--primary)] underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    );
  }
  if (item.entityType === 'Employee') {
    return (
      <Link
        to="/employees/$employeeId"
        params={{ employeeId: item.entityId }}
        onClick={(e) => e.stopPropagation()}
        title={title}
        className="font-medium text-[var(--primary)] underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    );
  }
  return (
    <span title={title} className="text-[var(--muted-foreground)]">
      {label}
    </span>
  );
}

function AuditLogList({ lockMine, withTabs }: { lockMine?: boolean; withTabs?: boolean }) {
  const profile = useGetMe();
  const navigate = useNavigate();
  const profileReady = profile.isSuccess;
  const canViewAll =
    profileReady && (hasAccessRule(profile.data, 20005) || hasAccessRule(profile.data, 20009));
  const allowed =
    profileReady &&
    (canViewAll || hasAccessRule(profile.data, 20002));

  const [scope, setScope] = React.useState<'mine' | 'all'>(lockMine ? 'mine' : 'all');
  const [action, setAction] = React.useState<string>(withTabs ? REVIEW_TABS[0].value : '');
  const [entityId, setEntityId] = React.useState('');
  const [debouncedEntityId, setDebouncedEntityId] = React.useState('');
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [items, setItems] = React.useState<AuditLogItem[]>([]);

  // Fail closed until the profile confirms AUDIT_VIEW: reviewers only see theirs.
  const effectiveMine = lockMine || !canViewAll || scope === 'mine';

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedEntityId(entityId.trim());
      setCursor(undefined);
      setItems([]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [entityId]);

  const resetPage = () => {
    setCursor(undefined);
    setItems([]);
  };

  const params: ListAuditLogsParams = {
    mine: effectiveMine ? true : undefined,
    action: (action || undefined) as ListAuditLogsParams['action'],
    entityId: debouncedEntityId || undefined,
    limit: PAGE_LIMIT,
    cursor,
  };
  const list = useListAuditLogs(params, {
    query: {
      queryKey: getListAuditLogsQueryKey(params),
      enabled: Boolean(allowed),
    },
  });

  // Cursor pagination with "Показать ещё": append, dedupe by id (StrictMode-safe).
  React.useEffect(() => {
    const data = list.data;
    if (!data) return;
    setItems((prev) => {
      if (!cursor || prev.length === 0) return data.items;
      const seen = new Set(prev.map((i) => i.id));
      const fresh = data.items.filter((i) => !seen.has(i.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, [list.data, cursor]);

  if (profileReady && !allowed) {
    return (
      <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
        <PageHeader
          title={withTabs ? 'Мои проверки' : 'История'}
          subtitle="Журнал действий проверяющих"
        />
        <Card>
          <CardContent>
            <EmptyState
              title="Нет доступа"
              description="Раздел доступен проверяющим (20002) и аудиту (20005)."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-[26px_28px_28px_28px]">
      <PageHeader
        title={withTabs ? 'Мои проверки' : 'История'}
        subtitle={
          withTabs
            ? 'Мои подтверждения и отклонения документов'
            : 'Журнал действий в пределах ваших прав доступа'
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {canViewAll && !lockMine && (
          <>
            <Button
              variant={scope === 'mine' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setScope('mine');
                resetPage();
              }}
            >
              Мои
            </Button>
            <Button
              variant={scope === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setScope('all');
                resetPage();
              }}
            >
              Все
            </Button>
          </>
        )}
        {withTabs ? (
          REVIEW_TABS.map((tab) => (
            <Button
              key={tab.value}
              variant={action === tab.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setAction(tab.value);
                resetPage();
              }}
            >
              {tab.label}
            </Button>
          ))
        ) : (
          <select
            aria-label="Действие"
            className={FILTER_CONTROL}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              resetPage();
            }}
          >
            {ACTION_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="Поиск по entityId"
          className={`${FILTER_CONTROL} min-w-[220px] flex-1`}
          placeholder="Поиск по ID объекта…"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
        />
      </div>

      {list.isLoading && items.length === 0 && (
        <Card>
          <CardContent>
            <p role="status" className="py-8 text-center text-sm">
              Загрузка истории…
            </p>
          </CardContent>
        </Card>
      )}
      {list.isError && (
        <Card>
          <CardContent>
            <div role="alert" className="flex items-center justify-between gap-3 py-4 text-sm">
              Не удалось загрузить историю.
              <Button variant="outline" size="sm" onClick={() => list.refetch()}>
                Повторить
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!list.isLoading && !list.isError && items.length === 0 && (
        <Card>
          <CardContent>
            <EmptyState
              title="Записей нет"
              description="Действий по заданным фильтрам пока не найдено."
            />
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <Card>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className={TH}>Время</th>
                    <th className={TH}>Автор</th>
                    <th className={TH}>Действие</th>
                    <th className={TH}>Объект</th>
                    <th className={TH}>Причина отклонения</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const linkable = auditLogLink(item) !== null;
                    return (
                      <tr
                        key={item.id}
                        onClick={linkable ? () => goToItem(navigate, item) : undefined}
                        className={
                          linkable
                            ? 'cursor-pointer border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]/60'
                            : 'border-b border-[var(--border)] last:border-0'
                        }
                      >
                        <td className={`${TD} whitespace-nowrap text-[var(--muted-foreground)]`}>
                          {new Date(item.createdAt).toLocaleString('ru-RU')}
                        </td>
                        <td className={TD}>{item.actorName ?? item.actorId ?? '—'}</td>
                        <td className={TD}>{auditActionLabel(item.action)}</td>
                        <td className={TD}>
                          <ObjectCell item={item} />
                        </td>
                        <td className={`${TD} max-w-[280px] truncate`} title={item.rejectionReason ?? ''}>
                          {item.rejectionReason ?? '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {list.data?.nextCursor && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  disabled={list.isLoading}
                  onClick={() => setCursor(list.data?.nextCursor ?? undefined)}
                >
                  {list.isLoading ? 'Загрузка…' : 'Показать ещё'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Full journal: mine/all scope (all only with 20005/20009), action + entityId filters. */
export function HistoryPage() {
  return <AuditLogList />;
}

/** Reviewer's own checks (mine=true): approved / returned tabs. */
export function MyReviews() {
  return <AuditLogList lockMine withTabs />;
}
