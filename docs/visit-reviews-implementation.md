# Реализация отзывов после визита

Статус: `COMPLETE`  
Спецификация: `docs/visit-reviews-spec.md` v1.0  
Ветка: `codex/visit-reviews`

## Чекпоинты

- [x] M1 — аддитивная миграция, типы и контракты
- [x] M2 — клиентский API, ownership, idempotency и коррекция исхода
- [x] M3 — безопасные агрегаты и RBAC
- [x] M4 — клиентский и рабочий React UI
- [x] M5 — server/integration и E2E тесты
- [x] M6 — OpenAPI, DATA-API, README, FUNCTIONALITY и итоговая проверка

## Что реализовано

### Данные и доменная модель

- `005_visit_reviews.sql` добавляет `visit_reviews` с рейтингом 1–5, состояниями active/invalidated, snapshot мастера и салона, optimistic version, составными tenant FK, уникальностью booking и индексами агрегата/владельца.
- Оценка связывается с финальным `staff_id`, `tenant_id` и `user_id` записи только на сервере.
- Коррекция completed → no_show/cancelled атомарно инвалидирует active review и пишет audit event. Обратная коррекция не восстанавливает его автоматически.

### API и безопасность

- `POST /api/v1/me/bookings/:b/review` создаёт или явно реактивирует оценку.
- `PATCH /api/v1/me/bookings/:b/review` изменяет active оценку с `expectedVersion`.
- Клиентские списки и детали записей получили собственное review-состояние без раскрытия чужих данных.
- Booking и review блокируются в одинаковом порядке; уникальный индекс и version сохраняют корректность независимо от глобального advisory lock.
- Все мутации используют существующую idempotency-оболочку и аудит.
- Рабочие endpoints показывают владельцу/администратору только агрегат, мастер видит только собственный агрегат. Индивидуальные оценки сотрудникам не выдаются.
- Публичный каталог скрывает и среднее, и количество до трёх active оценок.

### Интерфейс

- В истории клиента видны сохранённая оценка или приглашение оценить завершённый визит.
- В карточке визита добавлен доступный radio-контрол на 1–5 звёзд, состояния create/edit/invalidated, блокировка повторного tap и понятная обратная связь.
- В карточках мастеров рабочего кабинета и профиле мастера показан внутренний агрегат.
- На витрине рейтинг появляется только после privacy threshold.
- Контрол проверен на desktop и Pixel 7 viewport; горизонтального переполнения нет.

### Документация

- Обновлены `README.md` и `docs/FUNCTIONALITY.md`.
- `docs/openapi.json` и `docs/DATA-API.yaml` заново сгенерированы из 148 зарегистрированных endpoints.

## Матрица требований

| Acceptance criteria | Реализация | Проверка |
|---|---|---|
| VR-AC-01…07 | `reviews.routes.ts`, schemas, booking DTO, review UI | create/read/update, validation, duplicate, no DELETE и неподходящие статусы в `platform.test.ts`; desktop/mobile E2E |
| VR-AC-08…09 | ownership по `bookings.user_id`; текущая подтверждённая CRM-привязка обновляет исторические bookings | unlinked/linked manual visit и чужой user в `platform.test.ts` |
| VR-AC-10…12 | booking row lock + invalidation в `bookings.ts`; явная реактивация POST | correction/invalidate/reactivate integration test; общий command lock и одинаковый row-lock order |
| VR-AC-13…16 | `operations` fingerprint/idempotency, booking/review locks, unique booking, review version | repeat key/changed body, 20 concurrent POST, 2 concurrent PATCH |
| VR-AC-17…18 | tenant-scoped LATERAL aggregates только active reviews | aggregate create/update/invalidate path; публичный и рабочий tenant-scoped SQL |
| VR-AC-19…20 | work/my-profile RBAC; public threshold 3 | owner aggregate, master own profile, master denial списка, public 1/3 reviews |
| VR-AC-21…22 | snapshot columns и FK без cascade; public catalog фильтрует active staff | snapshot остаётся после rename; существующий archive flow и SQL-фильтр |
| VR-AC-23…24 | native radio inputs, focus state, responsive CSS, busy guard | Playwright desktop/mobile create/edit; серверная idempotency test |
| VR-AC-25…27 | аддитивная интеграция без новых notifications/outbox; bot-independent command | полный server regression 74/74, stopped-bot review test, чистая миграция и production build |

## Результаты проверок

Все проверки запускались локально с отдельными PostgreSQL и Redis, mock MAX; production и публичный домен не использовались.

| Команда/проверка | Результат |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS, production Vite build |
| чистый `npm run db:migrate` в `reviews_migration_test` | PASS, 001…005 применены последовательно |
| focused `vitest -t "post-visit master reviews"` | PASS, 6/6 |
| полный `npm test` с отдельными test PostgreSQL/Redis | PASS, 74/74 |
| Playwright `-g "rates a master"`, Chrome | PASS, desktop + mobile (2/2) |
| `npm run api:docs` | PASS, 148 endpoints |
| `git diff --check` | PASS |

Первый полный regression запуск использовал Redis уже работающего локального демо: существующий Live Window TTL-тест завис на конкурентном rate-limit state. Это не дефект продукта или отзывов. После запуска отдельного test Redis тот же тест прошёл за 1,6 секунды, а полный набор — 74/74. Для следующего QA-этапа изоляция Redis обязательна наряду с отдельной БД.

## Ограничения этапа

- Реальный MAX не проверялся и не требуется для оценок: функция не создаёт уведомлений.
- Полный визуальный и продуктовый regression всего приложения остаётся задачей этапа 3; здесь пройдены feature E2E и полный доступный server regression.
- Production, секреты, деплой и публичный домен не затрагивались.
