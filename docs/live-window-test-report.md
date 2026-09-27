# Независимый отчёт тестирования «Живое окно Lite»

Дата: 27 сентября 2026 года

Ветка: `codex/live-window`

Проверяемая реализация: `0bfe71e` и исправления стадии testing

Итоговый verdict: **PASS для доступной локальной автоматизации; реальные MAX transport/WebView проверки вынесены отдельно и не считаются пройденными**.

## Независимо найденный дефект

При принятии linked-offer API перечитывал актуальную запись, но не сравнивал её версию и статус со снимком request. Поэтому после параллельного обычного переноса старый offer мог повторно перенести уже изменённую запись. Исправлено в `packages/backend/live-window.routes.ts`: offer отзывается, request получает `suspended_incompatible/LINKED_BOOKING_CHANGED`, текущая запись остаётся без изменений. Добавлен regression test `revokes an open linked offer when the source booking changed`.

Также добавлен аудит пропуска кандидата по active-offer/cooldown/суточному лимиту без PII и high-cardinality labels.

## Матрица LW-AC

Все названия ниже относятся к `tests/platform.test.ts`, если файл не указан отдельно.

| AC | Статус | Доказательство |
|---|---|---|
| LW-AC01 | PASS | Во всех Live Window fixtures request создаётся без booking; `returns ordinary slots instead of creating a needless request` отдельно проверяет обратную ветку |
| LW-AC02 | PASS | `skips a wrong specific master and matches an any-master request` |
| LW-AC03 | PASS | тот же тест, ветка `staffIds=[]` |
| LW-AC04 | PASS | `uses the current shorter duration and rejects a duration longer than the window` |
| LW-AC05 | PASS | `does not offer a window inside the minimum-notice boundary` |
| LW-AC06 | PASS | `recovers an expired outbox lease without duplicating a window or offer` |
| LW-AC07 | PASS | `matches FIFO once, books atomically, and preserves accept idempotency` |
| LW-AC08 | PASS | `advances to the next FIFO candidate after an explicit decline` |
| LW-AC09 | PASS | `expires an offer and advances to the next FIFO candidate exactly once` |
| LW-AC10 | PASS | `serializes twenty competing accepts to one booking` |
| LW-AC11 | PASS | `lets an ordinary booking win while an offer is open` |
| LW-AC12 | PASS | `matches FIFO once, books atomically, and preserves accept idempotency` |
| LW-AC13 | PASS | тот же тест, `IDEMPOTENCY_KEY_REUSED` для изменённого body |
| LW-AC14 | PASS | `moves a linked booking without cascading its old slot` |
| LW-AC15 | PASS | `revokes an open linked offer when the source booking changed`; существующий `keeps original booking if the target slot is taken...` |
| LW-AC16 | PASS | `cancels a request, revokes its offer, and suppresses pending delivery` |
| LW-AC17 | PASS | `moves a stopped bot aside and offers the window to the next candidate` |
| LW-AC18 | PASS | `keeps requests and offers tenant scoped and denies the master queue` |
| LW-AC19 | PASS | `suspends a request when its selected master becomes inactive` |
| LW-AC20 | PASS | `revokes and suppresses active work when the platform flag is disabled`; RBAC pause/resume test |
| LW-AC21 | PASS | `honors a closed schedule exception introduced before matching`; existing break/exception scheduling regression |
| LW-AC22 | PASS | `uses the salon timezone when matching and snapshotting an offer` |
| LW-AC23 | PASS | `recovers an expired outbox lease without duplicating a window or offer` |
| LW-AC24 | PASS | `revokes an offer and changes fingerprint when match conditions change` |
| LW-AC25 | PASS | TTL test затем читает конечный `expired` через клиентский GET |
| LW-AC26 | PASS | FIFO/idempotency test проверяет один booking и ровно одну audit-запись `offer_booked` |
| LW-AC27 | PASS | `lets a manual work booking win while an offer is open` |
| LW-AC28 | PASS | полный regression обычной записи, loyalty и vouchers; platform flag test |
| LW-AC29 | PARTIAL/MANUAL | Playwright desktop/mobile проверяет authenticated клиентский и owner UI, отсутствие hold и responsive overflow; полный цикл внутри реального MAX WebView требует устройства/MAX staging |
| LW-AC30 | PASS | чистые PostgreSQL DB: миграции `001`–`004`, seed и запуск API; build/tests зелёные |
| LW-AC31 | PASS | decline и TTL tests проверяют sequence=2 и отсутствие повторного request/window |
| LW-AC32 | PASS | `uses the current shorter duration and rejects a duration longer than the window` |
| LW-AC33 | PASS | regression исправленного linked version/status conflict |
| LW-AC34 | PASS | linked success проверяет `cascade=false`; linked-change test проверяет обычный event `cascade=true` |
| LW-AC35 | PASS | параллельные cycle и просроченный lease дают один window/offer и processed event |
| LW-AC36 | PASS | same-tenant foreign user получает 404 на request/offer |
| LW-AC37 | PASS | `enforces owner/admin/master operational permissions` |
| LW-AC38 | PASS | tenant/IDOR test и успешная чистая миграция composite FK/unique constraints |
| LW-AC39 | PASS | own `lw_` deep link разрешён, чужой получает 404; auth suite проверяет tampered init data |
| LW-AC40 | PASS | bot-stopped/permanent channel path отзывает offer, подавляет delivery и выбирает следующего |
| LW-AC41 | PASS/PARTIAL | mock MAX test проверяет transient rate-limit retry с тем же offer; внешний crash-after-send duplicate остаётся честно возможным и требует staging fault injection |
| LW-AC42 | PASS | cancel/platform/bot tests проверяют suppression; TTL test проверяет безопасный stale state |
| LW-AC43 | PASS | `applies and later releases the per-request anti-spam limit without changing priority` плюс audit reason |
| LW-AC44 | PASS | audit-once assertion, cooldown audit; inspection новых логов/labels не выявила токенов, контактов или payload/PII |
| LW-AC45 | PASS | `returns ordinary slots instead of creating a needless request` |
| LW-AC46 | PASS/PARTIAL | Playwright desktop/mobile проверяет отсутствие обещания резерва и основные client/owner экраны; реальный MAX WebView offer countdown/три decline-действия остаются manual |

## Команды и результаты

- `npm run typecheck` — PASS.
- `npm run build` — PASS, production Vite bundle.
- `APP_ENV=test MAX_MODE=mock TEST_DATABASE_URL=... DATABASE_URL=... TEST_REDIS_URL=... REDIS_URL=... npm test` — PASS, 67/67 tests после расширения Live Window coverage.
- Чистые DB `salon_migration_test` и `salon_e2e_test`: `npm run db:migrate && npm run db:seed` — PASS.
- `E2E_BROWSER_CHANNEL=chrome npm run test:e2e` — PASS, 16/16: 8 desktop и 8 mobile.
- Browser plugin в сессии отсутствовал, поэтому по правилам frontend QA использован репозиторный Playwright. URL `http://localhost:5173`, проекты Desktop Chrome и Pixel 7/Chromium; Live Window screens, навигация, тексты и отсутствие горизонтального overflow прошли.

## Изоляция и ограничения

- PostgreSQL и Redis подняты отдельными временными контейнерами; база заканчивается на `_test`.
- MAX работал только в `mock`; production secrets, публичный production и домен не использовались.
- Не заявлены как пройденные: реальная доставка MAX, crash-after-send на внешней стороне и полный flow на физических MAX WebView. Это pre-production/staging checklist, а не локальный software blocker.
- Несвязанных regression-дефектов не обнаружено. В логах есть только существующие deprecation warnings Fastify/Node, не влияющие на результат.
