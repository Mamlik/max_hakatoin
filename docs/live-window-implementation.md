# Отчёт реализации «Живое окно Lite»

Дата завершения: 27 сентября 2026 года

Ветка: `codex/live-window`

Спецификация: `docs/live-window-spec.md`, версия 0.2

Baseline до функции: `f87b69e`

Статус: `IMPLEMENTED`; независимая стадия тестирования ещё не выполнена

## Чекпоинты

- [x] M1. Additive migration, feature flags, типы и API-контракты.
- [x] M2. Клиентские waitlist requests и linked booking «Хочу раньше».
- [x] M3. Durable domain outbox, окна, matching, TTL и последовательные offer.
- [x] M4. Транзакционный accept/decline, конкуренция и idempotency.
- [x] M5. MAX notifications/deep links, suppression и восстановление worker.
- [x] M6. Клиентские и рабочие React-экраны.
- [x] M7. Audit/metrics, OpenAPI, DATA-API, README и FUNCTIONALITY.
- [x] M8. Server/integration/e2e tests, typecheck и production build.

## Что реализовано

### Данные и инварианты

- `packages/db/migrations/004_live_window.sql`: tenant-safe таблицы settings, requests, selected staff, domain outbox, windows и offers; частичные unique indexes для активных offer/request/user, эквивалентных запросов и незавершённого linked booking.
- Offer хранит снимки услуги, мастера, начала/конца, цены, длительности и timezone. Domain event использует уникальный `booking.slot_released:{booking_id}:{version}`.
- Обычная отмена/перенос создаёт cascade-event; live-window перенос помечается `cascade=false` и не запускает цепочку старого слота.

### API и доменная логика

- `packages/backend/live-window.routes.ts`: полный клиентский CRUD/lifecycle запросов, список/карточка/accept/decline offer, owner settings, owner/admin pause/resume, окна, закрытие и агрегированный summary.
- Перед созданием запроса сервер повторно ищет обычные слоты и возвращает `SLOTS_AVAILABLE`; действует лимит трёх незавершённых запросов.
- Matching использует FIFO `priority_at,id`, длительность фактической услуги/linked booking, график, перерывы, исключения, timezone, notice, specific/any staff и антиспам.
- Accept повторно проверяет request version/fingerprint и общий booking invariant, работает через существующие quote/confirm операции и обязательный `Idempotency-Key`. Обычная/ручная запись может честно выиграть гонку без частичных изменений.
- Сервис, выбранные мастера или linked booking, ставшие несовместимыми, переводят request в `suspended_incompatible` с причиной.

### Worker, MAX и эксплуатация

- `packages/backend/live-window.ts`: durable claim с lease/fence/retry/dead, повторяемая обработка event, TTL и переход к следующему кандидату, request expiry, platform allowlist/kill switch.
- `apps/worker/main.ts`: повторная eligibility-проверка перед отправкой, TTL только после успешного mock/transport response, suppression на pause/off/cancel, permanent failure и `bot_stopped`, возобновление канала без оживления stale delivery.
- `packages/backend/identity.routes.ts`: safe `lw_` deep link без использования ссылки как credential.
- Реальные MAX secrets, production и публичный домен не использовались.

### UI и документация

- `apps/web/src/live-window-ui.tsx`: клиентские запросы/форма/offer и рабочий экран салона; mobile/desktop тексты явно говорят, что hold отсутствует.
- CTA добавлены к пустому поиску времени и будущей записи; добавлена навигация «Ожидание»/«Живое окно».
- Обновлены README, `docs/FUNCTIONALITY.md`, OpenAPI и DATA-API; генератор видит 146 endpoints.

## Связь с проверками реализации

| Область | Проверка |
|---|---|
| FIFO, один offer, accept и idempotency | `tests/platform.test.ts` — `matches FIFO once, books atomically, and preserves accept idempotency` |
| Обычная запись во время offer | `lets an ordinary booking win while an offer is open` |
| Linked booking, отсутствие cascade | `moves a linked booking without cascading its old slot` |
| Tenant/IDOR и master RBAC | `keeps requests and offers tenant scoped and denies the master queue` |
| Конкуренция booking, loyalty, coupons | существующий полный regression, включая 20-way booking и voucher races |
| Mobile/desktop основные экраны | `tests/e2e/app.spec.ts` — `client and owner can open Live Window screens` |

Полное сопоставление LW-AC01–LW-AC46 и негативные worker/MAX сценарии намеренно остаются отдельной независимой стадией `testing`; этот отчёт не выдаёт их за уже пройденные.

## Выполненные команды и результаты

- `npm run typecheck` — успешно.
- `npm run api:docs` — успешно, 146 endpoints.
- `npm run build` — успешно, production web bundle собран.
- `TEST_DATABASE_URL=... DATABASE_URL=... TEST_REDIS_URL=... REDIS_URL=... npm test` — успешно: 2 test files, 48 tests.
- Чистая PostgreSQL 17 test DB: миграции `001`–`004` и `npm run db:seed` — успешно.
- `E2E_BROWSER_CHANNEL=chrome npm run test:e2e -- --grep "client and owner can open Live Window screens"` — успешно: desktop и mobile, 2/2.

Все проверки использовали отдельные локальные test DB/Redis и mock MAX. Следующий этап должен независимо перепроверить требования, расширить coverage по каждому LW-AC и исправлять только дефекты Live Window.
