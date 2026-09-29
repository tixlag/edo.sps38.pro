import { Injectable } from '@nestjs/common';
import type { DashboardResponseDto } from './dto/dashboard-response.dto';

/** Deterministic demo payload mirroring Pencil Dashboard — ЕЗД blocks. */
@Injectable()
export class DashboardService {
  get(): DashboardResponseDto {
    return {
      source: 'seed',
      kpis: [
        { key: 'queue', label: 'Очередь проверки', value: '11', hint: 'документов ждут проверки' },
        { key: 'stuck', label: 'Застряли в оформлении', value: '6', hint: 'требуют внимания' },
        { key: 'signing', label: 'Ждут подписи', value: '4', hint: 'договора на подписи' },
        { key: 'hired', label: 'Оформлено за период', value: '18', hint: 'за последние 30 дней' },
        { key: 'expiring', label: 'Истекает в 30 дней', value: '7', hint: 'патенты и полисы' },
        { key: 'rework', label: 'Много исправлений', value: '3', hint: 'возвращены повторно' },
      ],
      weekly: [
        { day: 'Пн', value: 4 },
        { day: 'Вт', value: 6 },
        { day: 'Ср', value: 3 },
        { day: 'Чт', value: 7 },
        { day: 'Пт', value: 5 },
        { day: 'Сб', value: 2 },
        { day: 'Вс', value: 1 },
      ],
      stages: [
        { label: 'Приглашены / вход', value: 12 },
        { label: 'Проходят путь', value: 24 },
        { label: 'Заблокированы', value: 6 },
        { label: 'Проверка и комплект', value: 11 },
        { label: 'Подписание', value: 4 },
        { label: 'Оформлены', value: 18 },
      ],
      activity: [
        {
          kind: 'reminder',
          title: 'Напоминание о сроке — Патент — Гафуров Мурад Алишерович',
          time: '2 мин назад',
        },
        {
          kind: 'return',
          title: 'Возврат документа — Сертификат о владении русским языком — Холов Джамшед Фирузович',
          time: '18 мин назад',
        },
        {
          kind: 'check',
          title: 'Проверка документа — СНИЛС — Холов Джамшед Фирузович',
          time: '1 ч назад',
        },
        {
          kind: 'erp',
          title: 'Данные получены из 1С ERP — Паспорт — Каримов Азиз Шарифович',
          time: '2 ч назад',
        },
        {
          kind: 'check',
          title: 'Проверка документа — Миграционная карта — Сапаров Нурлан Эмилевич',
          time: '3 ч назад',
        },
      ],
      blocked: [
        { fullName: 'Токтогулов Айбек Русланович', step: 'Проверка патента' },
        { fullName: 'Осмонов Санжар Талантович', step: 'Дактилоскопия' },
      ],
      tasks: [
        { title: 'Проверить страховой полис ДМС — Назаров Фаррух', due: 'today' },
        { title: 'Проверить дактилоскопию — Назаров Фаррух', due: 'today' },
        { title: 'Подготовить заявку на патент — Назаров Фаррух', due: 'today' },
      ],
    };
  }
}
