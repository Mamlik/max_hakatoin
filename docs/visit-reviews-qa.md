# Независимый QA-отчёт: отзывы после визита и полный regression

Дата: 28 сентября 2026 года  
Ветка: `codex/visit-reviews`  
Проверяемая реализация: `cb04096` и test-scoped дополнения стадии QA  
Спецификация: `docs/visit-reviews-spec.md` v1.0

Итоговый verdict: **PASS для всей доступной локальной автоматизации**. Реальная доставка и WebView MAX вынесены в отдельный ручной staging-checklist и не выдаются за пройденные.

## Среда и изоляция

- PostgreSQL 17: отдельные базы `reviews_full_qa_test`, `reviews_e2e_full_test` и `reviews_upgrade_test`; каждая заканчивается на `_test`.
- Redis: отдельный test instance, не Redis локальной демо- или production-среды.
- MAX: только `APP_ENV=test`, `MAX_MODE=mock` и синтетические test credentials.
- Browser: установленный Chrome; Playwright projects `desktop` и `mobile` (Pixel 7 viewport), один worker.
- Production, публичный домен, реальные секреты и deployment не использовались.

## Что было добавлено при независимой проверке

В реализации не обнаружен новый product defect. Обнаружены и закрыты пробелы доказательной базы:

- гонка создания review с коррекцией исхода визита;
- отдельная конкуренция 2 и 20 первых оценок;
- повтор PATCH с тем же idempotency key и изменённое тело того же ключа;
- публичный privacy threshold отдельно при двух и трёх оценках;
- пересчёт агрегата после invalidation и reactivation;
- сохранение reviews после архивирования мастера;
- отсутствие новых delivery при остановленном MAX bot;
- keyboard-путь star control и устойчивое ожидание уже существующей оценки при повторном E2E.

Первый прогон нового archive assertion ожидал обычный `200`, тогда как общая command-обёртка проекта корректно возвращает `201`; исправлен тест, не продукт. Первый повторный desktop E2E мгновенно проверял ещё загружающееся состояние и завис; ожидание состояния сделано явным, после чего focused и полный повторные прогоны зелёные.

## Матрица VR-AC

Все server/integration проверки ниже находятся в `tests/platform.test.ts`, browser-проверки — в `tests/e2e/app.spec.ts`.

| AC | Статус | Доказательство |
|---|---|---|
| VR-AC-01 | PASS | create/get/update test и desktop/mobile `client rates a master...` |
| VR-AC-02 | PASS | validation 0, 6, fraction, string и strict schema |
| VR-AC-03 | PASS | confirmed/cancelled/no_show возвращают `BOOKING_NOT_COMPLETED` |
| VR-AC-04 | PASS | чужой user/booking получает 404; общий tenant/IDOR regression зелёный |
| VR-AC-05 | PASS | повторный active POST не создаёт вторую строку |
| VR-AC-06 | PASS | update с version и stale `VERSION_CONFLICT` |
| VR-AC-07 | PASS | DELETE отсутствует; UI предлагает только изменение |
| VR-AC-08 | PASS | unlinked manual completed booking недоступен |
| VR-AC-09 | PASS | подтверждённая CRM-привязка открывает историю только связанному user |
| VR-AC-10 | PASS | correction атомарно invalidates review; внутренний агрегат становится 0 |
| VR-AC-11 | PASS | обратная correction не восстанавливает; новый POST реактивирует строку |
| VR-AC-12 | PASS | `serializes first review creation against an outcome correction` |
| VR-AC-13 | PASS | одинаковые POST и PATCH key/body возвращают прежний результат без bump |
| VR-AC-14 | PASS | изменённые POST и PATCH body с прежним key дают `IDEMPOTENCY_KEY_REUSED` |
| VR-AC-15 | PASS | отдельные 2-way и 20-way POST races: одна строка и один успех |
| VR-AC-16 | PASS | два PATCH одной version: один success, один conflict |
| VR-AC-17 | PASS | create/update/invalidate/reactivate aggregate assertions, только active |
| VR-AC-18 | PASS | tenant-scoped booking ownership, staff aggregate SQL и общий foreign CRM/IDOR regression |
| VR-AC-19 | PASS | owner aggregate, master own aggregate, master list denial; individual ratings не выдаются |
| VR-AC-20 | PASS | public aggregate скрыт при 1 и 2, равен 4.0/3 при трёх reviews |
| VR-AC-21 | PASS | rename staff и tenant не меняет оба snapshot; связь остаётся по staff id |
| VR-AC-22 | PASS | archive скрывает мастера публично, сохраняет три review и work aggregate |
| VR-AC-23 | PASS | native accessible radios, desktop/mobile pointer flow и keyboard ArrowLeft flow |
| VR-AC-24 | PASS | UI busy guard проверен инспекцией; server idempotency/concurrency проверены фактически |
| VR-AC-25 | PASS | полный server regression и 18 browser cases: booking, CRM, loyalty, vouchers, partnerships, MAX mock, Live Window |
| VR-AC-26 | PASS | clean 001–005, populated 004→005, повторный migration runner, typecheck/build/tests |
| VR-AC-27 | PASS | stopped bot review создаётся, число delivery не меняется |

## Полный продуктовый regression

| Область | Статус | Фактическая проверка |
|---|---|---|
| Создание и публикация салона | PASS | server flow без seed: tenant → service → staff → schedule → publish; owner browser navigation |
| Медиа салона/услуг/мастеров | PASS | desktop/mobile upload, publish, storefront и carousel изображения |
| Услуги, мастера, график | PASS | CRUD/coverage server tests; browser orphan-service, media и master profile flows |
| Обычная запись | PASS | slot calculation, 20-way confirmation, idempotency, cross-salon challenge; browser slot selection |
| Ручная запись и CRM linking | PASS | manual booking, two-sided linking, permissions и historical ownership |
| Перенос и отмена | PASS | сохранение исходной записи при конфликте, price snapshot, reward transfer/release, reminder suppression |
| Исходы, no-show и correction | PASS | stale/future guards, loyalty/review invalidation и correction conflicts |
| CRM, роли, tenant isolation | PASS | foreign CRM denial, owner/admin/master RBAC, revoked access и UUID probing |
| Лояльность | PASS | threshold, 20-way completion, reserve/release/redeem, correction, pause; desktop/mobile UI |
| Партнёрства и купоны | PASS | acceptance hash, 20-way reserve, redeem, pause ownership, price preservation |
| MAX mock lifecycle | PASS | deep links, webhook secret, durable persistence, stop/suppression, Android Back bridge |
| Отзывы | PASS | все VR-AC и desktop/mobile create/edit/keyboard |
| Startup | PASS | API и worker одновременно стартуют; `/health/live` и `/health/ready` подтверждают DB и worker ready/mock |

Некоторые рабочие действия (например, manual booking, перенос, отмена и partnership state machine) проверяются через реальный HTTP API + PostgreSQL integration, а не отдельным кликом для каждого шага в Playwright. Репрезентативные клиентские и рабочие UI-поверхности проходят в обоих viewport. Это ограничение глубины browser-suite, но не пропуск доменной или authorization-проверки.

## Live Window Lite

Независимый прогон подтвердил все существующие 23 Live Window integration tests и связанные booking tests:

| Сценарий | Статус | Проверка |
|---|---|---|
| FIFO и один window/offer | PASS | `matches FIFO once...`; expired lease recovery |
| Конкуренция 2/20 | PASS | базовый ordinary booking race и 20 competing offer accepts |
| Repeat accept / changed body | PASS | idempotent success, одна audit-запись, `IDEMPOTENCY_KEY_REUSED` |
| Обычная/ручная запись во время offer | PASS | оба варианта выигрывают, поздний accept безопасно конфликтует |
| TTL, decline, следующий клиент | PASS | expiry и explicit decline дают sequence 2 ровно один раз |
| Linked booking | PASS | успешный move без cascade; изменение source booking отзывает offer и сохраняет актуальную запись |
| Длительности и границы | PASS | shorter current duration, too-long rejection, minimum notice |
| График, break, exception, timezone | PASS | break/closed-day ordinary slots, closed exception, salon timezone snapshot |
| Любой/конкретный мастер | PASS | wrong specific skipped, any-master matched, inactive suspension |
| bot stopped и suppression | PASS | кандидат отложен, delivery suppressed, следующий получает offer |
| Worker restart / event replay | PASS | expired outbox lease без duplicate window/offer |
| Feature flag off | PASS | requests/offers revoked, deliveries suppressed |
| Tenant/IDOR/RBAC | PASS | foreign 404, master queue denial, owner/admin/master permissions |
| UI mobile/desktop | PASS | authenticated client/owner screens, no-hold copy, checkbox alignment, no overflow |

Полная подробная карта LW-AC остаётся в `docs/live-window-test-report.md`; текущий QA повторно выполнил эти тесты, а не принял старый отчёт за доказательство.

## Команды и результаты

| Проверка | Итог |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS, production Vite bundle |
| clean `npm run db:migrate` в `reviews_full_qa_test` | PASS, 001…005 |
| повторный migration runner | PASS, no-op |
| populated upgrade 004→005 в `reviews_upgrade_test` | PASS, 8 bookings сохранены, новая таблица доступна |
| API + worker startup, health live/ready | PASS, DB ready и worker `ready/maxMode=mock` |
| focused review suite | PASS, 7/7 |
| полный `npm test` | PASS, 75/75 |
| focused Playwright после harness fix | PASS, 2/2 |
| полный Playwright Chrome | PASS, 18/18: 9 desktop + 9 mobile |
| `npm run api:docs` | PASS, 148 endpoints, без diff |
| `git diff --check` | PASS |

Известны только существующие deprecation warnings Node/Fastify; они не влияют на результат и не относятся к review feature.

## Ручные MAX/staging-пункты

Следующие пункты нельзя честно подтвердить локальным mock и они **не считаются пройденными**:

- подпись реального MAX `initData` внутри фактического Mini App WebView;
- доставка реальных сообщений/deep links и поведение при реальном `bot_stopped` webhook;
- внешний crash-after-send и возможный duplicate на стороне транспорта MAX;
- touch/Back/keyboard поведение на физических Android/iOS устройствах MAX;
- публичный HTTPS-домен, CSP/cookies и сетевые отказы реального staging.

Отзывы не создают новую рассылку, поэтому эти ручные пункты не блокируют локальный software verdict, но обязательны перед внешним пилотом.

## Итог

Все локально автоматизируемые VR-AC и доступный regression зелёные. Обязательных проваленных тестов и незадокументированных дефектов нет. Ветка готова к этапу 4 — безопасному слиянию в `main` с повторным post-merge smoke.
