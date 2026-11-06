# Финальная консолидация EDO ↔ LK ↔ 1С ERP

Дата: 2026-11-06. Это отчёт о коде и проверках, не акт production-развёртывания.

## A. Итоговое состояние

| Репозиторий | Цель | Итоговый SHA | Результат |
|---|---|---|---|
| websps/lk.sps38.pro | main | 9db4b0648a0e1742fa962c041dd061ee8e132ce4 | BLOCKED: автоматический production deploy |
| webdevs/edo.sps38.pro | main | c14f31b94f06e07a105cea44790dee41f7b7fc9d | MERGED, !50 |
| 1cdevs/1c-erp | feature/1C-452367-direct-adaptation-grants | 919ad1e1396625c4ef96e34401bc2bd40e4897fa | READY_FOR_TEST; единственный Draft !1482, без merge develop |

LK опубликован в [PR #2639](https://github.com/websps/lk.sps38.pro/pull/2639), HEAD `f81b258b34faaa78fd97e7c958931c92c6ce67f4`.
Основа `4719e3f5f9922393d02b99587686513628d0c4e1` сохранена целиком. Добавлены три обычных merge: upstream main d0ae293a8, #2559 и main 9db4b0648 (#2638/#2640, tickets/vehicle). Последние два изменённых PHP-файла прошли php -l; полные тесты после последнего merge не повторялись. Ни одного удаления функциональности ради сокращения diff, cherry-pick или force-push не выполнялось.

**Блокер LK:** `.github/workflows/main.yml` запускается на push main и непосредственно обновляет production (rsync, env, контейнеры). Environment production содержит только branch policy, без reviewer approval. Без изменения CI/защит невозможно гарантировать merge без deploy. CI и защиты не отключались. Дополнительно полная регрессия LK пока не зелёная, см. ниже.

**EDO:** !50 обновлён от main `3eb0861ed947036b2fabbda1bff136a5e01ab26a`; итоговый source HEAD `7541498cda24bef90cec038b48410345609f6903`. Merge выполнен через GitLab API с проверкой точного SHA. API/web deploy — manual job. OCR diff к предшествующему main пуст; в pipeline отсутствуют OCR jobs. Production jobs вручную не запускались. LK ещё не выпущен, поэтому сквозная работа новой интеграции на production не заявляется.

**1С:** во время работы develop изменился с `6f7e0498c34e6fda5dec3496ab66dbd4ef81c12a` до `1437b70a502522cc865776ed444fe2cd20ea48ad`. Обе версии последовательно включены обычными merge; тесты повторены. Исходный HEAD !1482 и все его предки сохранены. Новых веток приёмки не создавалось, develop не изменялся агентом.

## B. PR/MR

Все перечисленные ссылки относятся к основным проектам. Полная начальная выгрузка открытых и недавно слитых LK PR и последних GitLab MR — в соседнем CSV.

| PR/MR | Source → target | Исходный HEAD | Итог |
|---|---|---|---|
| [LK #2559](https://github.com/websps/lk.sps38.pro/pull/2559) | fix/candidate-chat-multiple-sessions → main | 0acb33531eba7b9a6270d48c286058b6edcbd1fd | Включён ancestry в #2639, открыт до merge консолидации |
| [LK #2596](https://github.com/websps/lk.sps38.pro/pull/2596) | feat/edo-review-ru-ig → main | 4b9afa633a73a8cabfaf1db2ee725836b56e097b | Включён ancestry в #2639, открыт |
| [LK #2630](https://github.com/websps/lk.sps38.pro/pull/2630) | feat/edo-notifications → main | 8ed094e59ee4c7fd1a88e0a536d4b02acede3630 | Включён ancestry в #2639, открыт |
| [LK #2633](https://github.com/websps/lk.sps38.pro/pull/2633) | fix/edo-notification-recipient-resolution → main | 673dad2f31de257017b0362337b920c50a546029 | Включён ancestry в #2639, открыт |
| [LK #2637](https://github.com/websps/lk.sps38.pro/pull/2637) | feat/ig-arrival-context-clean → main | a0dc2a3ffe522b72e9513d3a02e8e1d831950b42 | Включён ancestry в #2639, открыт |
| [LK #2639](https://github.com/websps/lk.sps38.pro/pull/2639) | tixlag:feat/edo-ig-full-integration-clean → websps:main | 4719e3f5f9922393d02b99587686513628d0c4e1 (до консолидации) | OPEN, HEAD f81b258b34faaa78fd97e7c958931c92c6ce67f4, merge заблокирован |
| [EDO !16](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/merge_requests/16) | feat/candidate-chat-workspace → main | 090d02ce7b5f6758367a31f9a7e80d59135cd8f7 | MERGED автоматически по ancestry !50, тот же merge SHA |
| [EDO !47](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/merge_requests/47) | feat/notification-expiration-control → main | f258f04663707fe3d738a1d9997c358f39e5dd7b | CLOSED, заменён !50; не является ancestor, реализация перенесена в 16ea3d8 и дополнена FIX-03/FIX-04 |
| [EDO !50](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/merge_requests/50) | fix/ig-erp-confirmed-delivery → main | ba9135db4804135606a30e834bc95e6223c4cff1 | MERGED c14f31b94f06e07a105cea44790dee41f7b7fc9d |
| [1С !1349](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1349) | feature/1C-452367-edo-candidate-integration → develop | e1af6a65cf1e0941f653d8039dfb563e9deace92 | CLOSED, полный HEAD включён ancestry в !1482 |
| [1С !1481](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1481) | fix/FIX-08-direct-adaptation-grants → develop | 24954019add1298ebbd07551c4021cd4631459c0 | CLOSED, полный HEAD включён ancestry в !1482 |
| [1С !1482](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1482) | feature/1C-452367-direct-adaptation-grants → develop | c8ff4632480a48a0932d453e20c12bcbc16ecd23 | Единственный OPEN Draft, HEAD 919ad1e1396625c4ef96e34401bc2bd40e4897fa |

Старые MR 1С закрыты с объяснением и ссылкой на !1482; их история сохранена. Изменения идентификации заездов вплоть до `a7f2b869` входят ancestry в финальную 1С.

Параллельные LK `feat/edo-adaptation-queue` (d924bbf7e3d54a29ea17ca53fa7c08bda205611b) и `feat/ig-arrival-context-integration` (78312652d6a90465f201650052dc220f052e4f2b) имеют другую историю. Для первой проверены 42 пути уникальных коммитов: 33 совпадают с финальной консолидацией, 9 развиты более новой реализацией документов/заездов/FIX-08. Среди совпадающих сохранены доработки рейтинга и HTTP timeout. Последний коммит второй имеет эквивалентный patch-id в консолидации. Повторное массовое перенесение старой истории не выполнялось.

## C. Проверки и ограничения

| Подсистема | Проверка | Результат | Примечание |
|---|---|---|---|
| LK чаты | Go app, chat/core, chat/usecases, candidates | PASS | Многовкладочные candidate sessions, broadcast и независимое отключение покрыты тестами #2559 |
| LK чаты | go test ./... | FAIL | Уже в upstream main: отсутствует broadcasts/usecases; тест ссылается на отсутствующий buildMySQLDSN. Два интеграционных теста требуют TEST_REQUESTER_CODE_1C |
| LK frontend | adaptation Vitest | PASS | 26 файлов, 164 теста; сгенерирован access-rules.instance; Node webstorage выключен для тестового окружения |
| LK frontend | полная сборка | BLOCKED | В снимке отсутствуют генерируемые routeTree/LK API, много производных TS ошибок; успех не заявлен |
| Surveys backend | Nest build | PASS | Код итогового снимка |
| Surveys backend | Jest | BLOCKED | Локальный resolver не находит ts-jest, в том числе под Node 22; тесты не считаются выполненными |
| Surveys frontend | build/test | BLOCKED | В локальном node_modules отсутствуют требуемые CLI (vitest/ng) |
| LK PHP | полный PHPUnit | FAIL | 1027 тестов, 4605 assertions, 272 errors, 1 failure, 47 skipped. WeldingFixHttpTest получил 500 вместо 403; полная регрессия не подтверждена |
| Surveys | чистая история SQL migrations | FAIL | Историческая seed migration 20260630020000_seed_living_conditions_survey: description слишком длинный |
| EDO API | тесты итогового снимка | PASS | 1004 passed, 139 skipped, 94 файлов passed; lk-real-infra исключён, внешние адреса для тестов закрыты |
| EDO web | unit tests | PASS | Выполнены общим pnpm test; API portion первого общего прогона упал на недоступной infra |
| EDO API/web | pnpm build | PASS | Свежий снимок; backend и frontend compile/typecheck |
| EDO | pnpm lint | PASS | 0 errors, 60 warnings |
| EDO | OpenAPI + Orval | PASS | Перегенерированные openapi.json и generated/api.ts байт-в-байт совпали |
| EDO | все SQL migrations на чистой MariaDB | PASS | 49 миграций, новый отдельный контейнер с tmpfs; shared DB не использовалась |
| EDO | Prisma migrate deploy | BLOCKED | P1001 в локальном engine, несмотря на доступный TCP и рабочий MariaDB CLI; SQL проверен отдельно |
| EDO FIX-08 | отсутствие dedicated env при наличии legacy aliases | PASS | Сначала 2 red теста, затем 18/18 green; отдельный commit 7541498c |
| 1С | .gitlab/tests/check-*.py | PASS | Все 57 статических/модельных проверок повторены после последнего merge develop |
| 1С | XML metadata/forms/rights | PASS | Изменённые XML разобраны; см. количество ниже |
| 1С | validate:mr | PASS | Локально и GitLab CI |
| 1С | обязательный review-policy | MANUAL | Требуется штатное человеческое ревью, gate не обходился |
| 1С | EDT/платформа/ERP_Noskov | НЕ ВЫПОЛНЕНО | Платформенное тестирование остаётся пользователю |
| Все | e2e / реальные внешние выдачи / production deploy | НЕ ВЫПОЛНЕНО | По ограничениям задания |

Подтверждённое исправление в этой сессии: ErpAdaptationGuard принимал ERP_ADAPTATION_TOKEN/ADAPTATION_ACCESS_TOKEN при отсутствующем EDO_ERP_ADAPTATION_TOKEN. Удалены два fallback, добавлен тест для каждого и для EDO_LK_INTERNAL_TOKEN. Отсутствие dedicated EDO env теперь закрывает маршрут. 1С новых настроек не получила.

Падения остальных LK проверок не выдаются за исправленные. Неизвестные регрессии сварки/несварочных звеньев/старых смен/транспорта должны быть проверены до будущего LK merge.

## D. Миграции и окружение

Новые LK/surveys пути относительно текущего LK main:

- `next/src/LK/Notifications/Entities/migrations/20261103190000.php`
- `next/src/LK/Notifications/Entities/migrations/20261105010000.php`
- `services/surveys/backend/prisma/surveys/migrations/20261103100000_edo_adaptation_grant_events/migration.sql`
- `services/surveys/backend/prisma/surveys/migrations/20261105000000_edo_arrival_context/migration.sql`

Surveys arrival migration добавляет `edo_arrival_person_states`, `edo_arrival_members`, `edo_adaptation_grant_operations`, сохраняет legacy employee adaptation через legacy_employee_code_1c и отдельный arrival_member_uid. Исторические миграции и checksum не переписывались. Проверка всей чистой истории блокируется более ранней seed migration, поэтому применение новых surveys миграций на чистой базе целиком не подтверждено.

Новые EDO миграции:

- `0026_retire_erp_document_v1`
- `20261020160000_candidate_communications`
- `20261026120000_candidate_business_identity`
- `20261102160000_restore_communication_audit_actions`
- `20261103150000_ig_employment_cycles`
- `20261103170000_document_expiration_alerts`
- `20261103180000_document_expiration_alert_delivery`
- `20261103190000_contract_notification_delivery`
- `20261103200000_expiration_alert_date_identity`
- `20261103210000_contract_notification_cancellation`
- `20261103220000_expiration_retry_fencing`
- `20261105001000_erp_attempt_receipt_validation`
- `20261105002000_previous_original_proof`
- `20261105003000_ig_arrival_projection`
- `20261105004000_ig_arrival_sync_pending`
- `20261105005000_ig_arrival_issues`
- `20261105006000_candidate_person_lookup`
- `20261105007000_arrival_verified_ig`
- `20261105008600_candidate_previous_documents_synced_at`
- `20261105008700_ig_arrival_sync_state`
- `20261105008800_candidate_profile_sync_retry`
- `20261105008900_expiration_alert_payload`
- `20261105009000_ig_arrival_sync_fencing`
- `20261105010000_ig_grant_events_idempotency_fingerprint`

Будущий выпуск: сначала решить историческую установку surveys и закончить регрессию LK; затем отдельным разрешённым этапом подготовить резервные копии и применить штатные LK domain/surveys migrations до запуска соответствующего нового кода. После этого отдельный EDO release: Prisma migrations, API/web, проверка S2S; фоновые синхронизации включать только после совместимости ERP endpoint. Версию 1С сначала проверить в ERP_Noskov; production ERP не менялась.

Настройки (без значений секретов):

- 1С: существующий `HTTP_OUT_TOKEN_06 / adaptation`; один и тот же секрет используется surveys и EDO. Новых идентификаторов/подключений нет.
- EDO: `EDO_ERP_ADAPTATION_TOKEN` получает то же значение; `EDO_LK_INTERNAL_TOKEN` не меняется. Отсутствие adaptation env → 401.
- LK/surveys: существующий `ADAPTATION_ACCESS_TOKEN`; штатные внутренние EDO/LK токены остаются раздельными.
- ERP HTTP API: существующие `ERP_CANDIDATE_TOKEN`, `ERP_DOCUMENTS_TOKEN`, `ERP_USERNAME`, `ERP_PASSWORD`; `ERP_COMMUNICATIONS_URL`, `ERP_CANDIDATE_URL`, `ERP_DOCUMENTS_BASE_URL` указывают на согласованную публикацию.
- Чаты/уведомления: `LK_CHAT_BASE_URL`, `LK_PUBLIC_BASE_URL`, `VITE_LK_WS_URL`; проверить production WebSocket URL при будущем web build.
- Заезды: `EDO_ARRIVAL_SYNC_ENABLED` оставлен выключенным по умолчанию; `EDO_ARRIVAL_CONTEXTS_URL` и `EDO_ADAPTATION_SYNC_TOKEN` требуют проверки против прямого ERP источника, старые комментарии .env.example не являются runtime контрактом.
- Сохранить `ERP_DOCUMENTS_V2_AUTO_RETRY=false` до платформенной приёмки идемпотентности.
- Неустановленные cron, rollout фоновых workers, регистрация прав и production env/миграции остаются отдельными инфраструктурными действиями. В этой сессии они не выполнялись.

## E. ERP_Noskov

- Репозиторий: `1cdevs/1c-erp`.
- Ветка: `feature/1C-452367-direct-adaptation-grants`.
- HEAD: **`919ad1e1396625c4ef96e34401bc2bd40e4897fa`**.
- MR: [единственный Draft !1482](https://glab.sps38.pro/1cdevs/1c-erp/-/merge_requests/1482).
- Целевая база: **ERP_Noskov**. Не merge develop.
- Проверено статически: контракты карточки/идентификации/документов, участие в заездах и переходы, bootstrap/pagination, привязка форм/списков, single-button retry и неизменность operationId.
- Структура проекта `.project`, `DT-INF/PROJECT.PMF`, `src` проверена штатным validate-mr. Сам импорт EDT/загрузка расширения и BSL runtime здесь не выполнялись; возможность загрузки требует платформенной проверки.

Тестировать только выделенными тестовыми физлицами: code1c уникален; personUid должен соответствовать identity того ERP, к которому реально обращается EDO. Если ERP_Noskov и production ERP дают разные UID для code1c, EDO отклонит выдачу/историю. Нельзя обходить эту сверку или подставлять чужой UID.

**ERP_Noskov использует существующие production URL LK/surveys и EDO. Кнопка может создать реальные внешние операции. Не использовать реальных сотрудников; заранее согласовать тестовые личности и маршрутизацию.**

Ручная приёмка:

1. Загрузить точный HEAD штатным процессом EDT/расширения в ERP_Noskov, проверить compile и права сервисной учётной записи.
2. Создать тестового RU-кандидата, изменить карточку и допустимый статус; найти существующее физлицо и подтвердить связь. Проверить уникальный code1c и неизменённый chat_uuid (`uuid` /Candidate).
3. Открыть чат кандидата и оператора в нескольких вкладках. Проверить доставку всем соединениям и продолжение после закрытия одной вкладки, затем обычный LK чат.
4. Загрузить оригинал документа, получить/проверить, вернуть с причиной, загрузить новую версию и проверить историю ранее подтверждённых файлов.
5. Создать тестовый заезд ИГ, изменить состав/заезд, сверить состояние и историческую адаптацию; проверить RU/IG права.
6. Нажать единственную «Выдать доступ»: проверить персональные code1c/operationId/applied/known и независимые подтверждения LK/EDO.
7. Повторить после частичного отказа: запрос должен идти только неподтверждённой стороне с тем же operationId и параметрами; повторный успех не создаёт дубликатов.

Production deploy, кадровые операции, реальные выдачи, production env и shared DB в рамках задания не изменялись. Локальные незакоммиченные изменения параллельных сессий сохранены; подготовленное ими удаление ERP guard не включено в merge.

XML повторно проверено после последнего merge develop: 2 файлов, ошибок 0.

Локальный корневой `.env`: добавлены пустой EDO_ERP_ADAPTATION_TOKEN и EDO_ARRIVAL_SYNC_ENABLED=false. Секрет отсутствует и в локальном surveys env; значение не придумано. Перед будущим deploy заполнить EDO runtime env существующим adaptation-секретом 1С. Production env не изменялся.

Последний снимок EDO pipeline [5059](https://glab.sps38.pro/webdevs/edo.sps38.pro/-/pipelines/5059): lk-sync=manual, lk-topology=manual, infra-check=manual, deploy-production=created, build-web=success, build-api=running. OCR jobs отсутствуют; production deploy не запускался.

1С pipeline [5061](https://glab.sps38.pro/1cdevs/1c-erp/-/pipelines/5061): scope и validate success; review-policy manual.

Контроль CI при завершении: lk-sync=manual, lk-topology=manual, infra-check=manual, deploy-production=manual, build-web=success, build-api=success. Оба build job прошли; deploy-production остался manual и не запускался.

Где находится adaptation-секрет: 1С → Безопасность интеграций → Интеграционные подключения → код HTTP_OUT_TOKEN_06 → таблица Секреты → adaptation. Проверить секрет показывает заполненность, но форма не раскрывает значение. Для EDO взять существующее значение у администратора или из штатного surveys runtime ADAPTATION_ACCESS_TOKEN; не создавать и не перезаписывать секрет в 1С.


## Последующее разрешение и восстановление LK Actions

После отчёта пользователь самостоятельно выполнил squash merge #2639 (0ab9c8c378531d15521b3ebcc8baadff70130355). В squash message сохранилась историческая CI-skip аннотация, поэтому ни deploy, ни mirror run для merge созданы не были. Позднейшие push runs пропустили integration service jobs.

Пользователь затем явно поручил «сделай, чтобы сработало», разрешив восстановительный production run LK. В [PR #2643](https://github.com/websps/lk.sps38.pro/pull/2643) добавлен workflow_dispatch с обязательным base_sha, проверка main/ancestor/full SHA, checkout зафиксирован на github.sha и сериализация workflow без отмены активного deploy. Проверены YAML и actionlint v1.7.12 (существующий custom runner label учтён отдельно).

PR #2643 слит штатно, merge b1fdcf4a22adaec5e1e1b49864a33ac7e2184f88. Запущен [recovery run 42153730846](https://github.com/websps/lk.sps38.pro/actions/runs/42153730846) с base_sha=9db4b0648a0e1742fa962c041dd061ee8e132ce4. Validate deployment range и make-filters прошли; отслеживается завершение service jobs. EDO production deploy этим разрешением не запускался.

Восстановительный LK run завершён: completed/success, SHA b1fdcf4a22adaec5e1e1b49864a33ac7e2184f88. Backend (включая Phinx), public_next frontend, chat-server и surveys backend — success. Surveys frontend пропущен по отсутствию изменений.
