import { Badge } from './badge';

const toneByStatus: Record<string, 'info' | 'success' | 'warning' | 'danger' | 'default' | 'purple'> = {
  INVITED: 'default',
  ONBOARDING: 'info',
  BLOCKED: 'warning',
  IN_REVIEW: 'purple',
  SIGNING: 'info',
  HIRED: 'success',
  TODO: 'default',
  IN_PROGRESS: 'info',
  DONE: 'success',
  DRAFT: 'default',
  UPLOADED: 'info',
  OCR_PENDING: 'warning',
  OCR_FAILED: 'danger',
  RETURNED: 'warning',
  APPROVED: 'success',
  SIGNED: 'success',
  EXPIRED: 'danger',
};

const labelByStatus: Record<string, string> = {
  INVITED: 'Приглашён',
  ONBOARDING: 'Оформление',
  BLOCKED: 'Заблокирован',
  IN_REVIEW: 'Проверка',
  SIGNING: 'Подписание',
  HIRED: 'Оформлен',
  TODO: 'К выполнению',
  IN_PROGRESS: 'В работе',
  DONE: 'Готово',
  DRAFT: 'Черновик',
  UPLOADED: 'Загружен',
  OCR_PENDING: 'OCR',
  OCR_FAILED: 'OCR ошибка',
  RETURNED: 'Возвращён',
  APPROVED: 'Одобрен',
  SIGNED: 'Подписан',
  EXPIRED: 'Истёк',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={toneByStatus[status] ?? 'default'}>{labelByStatus[status] ?? status}</Badge>;
}
