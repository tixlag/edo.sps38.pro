# Доработка реестра для отдела кадров

Продолжение EDO !61 от ceecb6b9ea66cf8f0b2fb8296d64fb75246a73df и ERP !1507 от cf98dfdcbba96637782b9b3bbe9c835c4da2a0ce; зависимый !1493 9c912e34. Актуальные MR сверены через API и Git, новых коммитов после этих SHA нет. Существующие три агента Terra 6.1 High, без новых worktree.

- Frontend владеет apps/web: 4 колонки Сотрудник/Документы/Что требуется/Действие, readable rows, архив/URL/Drawer, предыдущая страница курсоров, visual wide realistic fixtures + контроль.
- Backend владеет apps/api/prisma/generated: обязательный комплект только из existing catalog/requiredApplicable/reuse, отдельные acceptance и delivery, authoritative nextAction, server filters/counts, clean и upgrade MariaDB migrations.
- ERP: !1493/!1507 overlap, participation/revision/time, available runtime/static, CI policy без выдуманного ID.
- Координатор: контракт, независимый diff review/tests, CI research, docs/Git/MR. Только GitLab, без merge/deploy/e2e/shared DB migrations. Scratch только .cache.

## Принятые решения

Primary action REVIEW при реально ожидающих решения документах даже с missing/returned/unknown requirements; профиль отсутствует → NONE. Неизвестные или конфликтные требования никогда не READY, пустой каталог не complete. Acceptance обязательного комплекта не доказывает доставку в 1С или оформление. Frontend не вычисляет применимость. Архив явно показывает current candidate document scope. Current default все даты (все активные участия), archive может использовать явный последний месяц и переключение Все даты.

## Этапы

- [x] Проверить HEAD/diff трёх MR.
- [x] Согласовать точные DTO/matrix backend/frontend перед зависимой реализацией.
- [x] Backend HR projection/filter tests и migration clean/upgrade.
- [x] Frontend4columns/prevpagination/URL и unit + visual.
- [x] ERP independent checks и runtime/CI blockers.
- [ ] Coordinator cross-review, final tests/build/generation, CI actualHEAD.
- [ ] Commit/push/update тех же MR, итоговый отчёт с evidence и remaining gates.

## CI ограничения исходного состояния

EDO использует внешний edo.yml@webdevs/ci-templates, в template build/deploy/ops разрешены только default branch; MR job отсутствует. Project/pipeline API возвращают403 доступным credential, template raw доступен. Исследовать безопасный способ MR validation, не менять production config/не запускать deploy. ERP validate-mr требует настоящий YouTrack ID в имени ветки; ID пока не предоставлен.

Координатор проверил:49 интеграционных тестов на двух выделенных MariaDB,1049 API tests,354 web tests,генерация OpenAPI/Orval,общая сборка4 задачи,lint0errors155warnings. Чистая цепочка50 и upgrade49→50 с проверкой сохранения3участий/hash/revision/index/FK подтверждены лично.
Внешние gates CI/runtime остаются открытыми, отсутствие pipeline не считать успехом.
