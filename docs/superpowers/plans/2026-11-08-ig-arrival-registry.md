# Списочные заезды ИГ — согласованный план и контракт

**Цель:** единый реестр дата → объект → участия с архивом, серверными фильтрами и существующей проверкой документов.
**Основание:** подробное ТЗ пользователя от 2026-11-08; выполнение ровно тремя агентами Terra 6.1 High, без дополнительных worktree.

## Владение и ограничения

- Backend: apps/api, prisma, packages/api-client; единственный владелец OpenAPI/Orval.
- Frontend: apps/web; Impeccable Operate, существующие токены и CandidateDrawer.
- 1C: ../1c-erp, минимальное расширение источника, отдельный MR в develop.
- Координатор: документация, интеграция, проверки и все Git mutations.
- Только GitLab; main/develop не менять, не деплоить, не запускать e2e или миграции рабочей БД. Существующие ветки сохранены.
- Базы: EDO d068ba48a3fc200fd39d3962734f88f9f5349eb3; ERP f26145d0d26646e8d866cdeede567d2881a0fb30.

## Архитектура и контракт

Существующие endpoints очереди сохраняются. Новые GET candidate-review-queue/ig-arrivals/groups и participations используют одинаковые фильтры: dateFrom/dateTo включительно, locationUid, q (ФИО/code1c), documentStatus, needsAttention, archive=current|archive. Ограниченная keyset-пагинация, курсор связан с фильтрами, порядок null-safe дата/объект/UUID участия. Изменения источника между страницами могут перемещать строки: snapshot isolation между HTTP-запросами не обещается.

Группа имеет стабильный groupKey, дату, UUID/название объекта, participationCount после фильтров и totalParticipationCount полного состава. Отдельный ключ проблемной группы позволяет избежать вымышленного UUID участия. Участие имеет personUid, arrivalMemberUid, candidateId|null, code1c, ФИО, дату/объект, participationStatus CURRENT/HISTORICAL/CANCELLED, personState, issueCodes, sourceRevision строкой.

Статусы независимы: documentStatus UNKNOWN/NO_DOCUMENTS/IN_PROGRESS/RETURNED/APPROVED (APPROVED не означает полноту требований), erpDeliveryStatus UNKNOWN/NOT_REQUIRED/PENDING/NEEDS_ATTENTION/CONFIRMED, локальный employmentStatus UNKNOWN/IN_PROGRESS/DOCUMENTS_COMPLETED. Факт оформления/статус 1С не выводится из этих значений. statusScope=CURRENT_CANDIDATE предупреждает, что в архиве это текущие документные данные карточки, а не исторический снимок документов участия.

1С добавляет только optional arrivalDateTime:string|null в формате YYYY-MM-DDTHH:mm:ss. Это локальное время источника без известного timezone, без UTC-конвертации; полночь не доказывает известное точное время. Старые snapshots допустимы без поля. Обогащение только по однозначно связанной исходной строке с revision bump при изменении JSON, повтор идемпотентен.

СтатусыИГ не экспортируются: ключ физлицо+участок+период не доказывает принадлежность конкретному повторному заезду. Без прямой связи статусы 1С UNKNOWN. Это отдельный блокер источника, не препятствие проверке документов.

История берётся из последнего полного массива снимков физлица. Старые projection rows сохраняются, но не выдаются как доказанное членство последнего снимка. Backend и 1С согласуют presence/backfill перед реализацией. igVerified и полномочия 20011/20009 обязательны; отсутствие адаптационного допуска не исключает verified участника.

sync.lastCompletedAt означает завершение прохода синхронизации, а не время HTTP-ответа или изменения конкретной записи ERP. Неизвестная актуальность обозначается явно.

## Реализация и проверки

- [x] Параллельное исследование трёх компонентов; сверка HEAD и открытых MR.
- [x] Создать EDO feat/ig-arrival-registry от GitLab main и ERP feat/ig-arrival-context от develop, сохранить прежние ветки.
- [x] Согласовать контракт, владельцев и ограничения.
- [x] Backend: целевые тесты фильтров/счётчиков/архива/прав/ревизий → API/projection → генерация клиента.
- [x] ERP: тесты старого снимка, изменения времени, повторов → optional время без статусов и рискованной миграции.
- [x] Frontend: серверный реестр и панель, debounce, URL/Back/Forward/возврат из документа, loading/error/empty/stale/permission.
- [x] Перекрёстное ревью API и source contract существующими тремя агентами.
- [x] Координатор: лично исходники/diff, targeted tests, builds/lint, визуальные свидетельства.
- [x] Отдельные коммиты/MR в GitLab; финальная матрица проверок и порядок внедрения без merge/deploy.

## Критические случаи ревью

Повторное участие одного человека; отмена/перенос/смена объекта; конфликт без currentMemberUid; отсутствие карточки; null-дата и объект; неполный sync; старый ERP без нового поля; mixed document delivery; права RU-only; историческая строка с текущими документами; возврат из документа с сохранением query/candidate.

Оставшиеся внешние gates: чистая цепочка миграций/EDO CI, failed ERP pipeline 5214 (jobs API 403), runtime 1С и live интеграционный сценарий. Draft MR: EDO !61, ERP !1507. Merge/deploy не выполнялись.

Дополнительный обнаруженный gate ERP: validate-mr.sh требует feature/1C-<номер>-..., текущая feature-ветка не проходит. Реальный YouTrack ID запрошен у пользователя; не выдумывать номер и не ослаблять policy.
