# Отчёт о реализации UI experiments, итерация 1

**Ветка:** `codex/ui-experiments`

**База:** `origin/main@8ee2e4770977b9a0a08132f523cddcd1be751162`

**Среда проверки:** локальная PostgreSQL `reviews_e2e_full_test`, локальный Redis, `MAX_MODE=mock`; production, публичный домен и production secrets не использовались.

## Итог

Обязательный первый срез реализован: безопасные темы и режимы витрины, варианты карточек услуг и мастеров, общий живой preview, draft/publish, галерея и focal point, компактная мобильная навигация, mobile-композиция записи и Live Window, доступный modal/lightbox и responsive-проверки. Бизнес-контракты booking, Live Window, loyalty, coupons и reviews не менялись.

Автоматизируемая часть принята: typecheck, production build, 78 server/unit/integration тестов и 22 desktop/mobile E2E прошли. UI-AC-18 остаётся честной ручной проверкой в реальном MAX WebView.

## Связь критериев с реализацией и проверками

| AC | Реализация | Доказательство | Результат |
|---|---|---|---|
| UI-AC-01 | `storefront-style.ts`, server `normalizeStyle` | platform: legacy style → v2 defaults → publish | PASS |
| UI-AC-02 | `storefront-editor.tsx`, `storefront-tokens.ts` | E2E owner theme/card preview; token unit test | PASS |
| UI-AC-03 | draft/preview/public routes и owner editor status | platform save/publish/public; E2E save/publish notices | PASS |
| UI-AC-04 | optimistic `expectedVersion`; локальный state меняется только после успешного ответа | существующая server version guard + typecheck/E2E happy path; код-проверка error path | PASS |
| UI-AC-05 | strict schema, tenant/purpose lookup, gallery max/unique | platform foreign gallery + duplicate sections; schema validation | PASS |
| UI-AC-06 | focal `object-position`, reorder controls, общий `StorefrontView`, lightbox | platform persisted style; E2E preview/public media; визуальная проверка | PASS |
| UI-AC-07 | статическая карта токенов без свободного CSS | `tests/theme-tokens.test.ts`, 24 комбинации | PASS |
| UI-AC-08 | responsive hero/cards/nav | E2E 320/390/768/1440, first-viewport CTA и overflow | PASS |
| UI-AC-09 | четыре primary + «Ещё», responsive role-based nav | desktop/mobile E2E owner/client navigation и drawer | PASS |
| UI-AC-10 | `useNavigationType`: scroll-to-top для PUSH, native restore для POP | код-проверка + desktop/mobile route smoke | PASS |
| UI-AC-11 | presentation-only booking progress/sticky CTA | desktop/mobile booking E2E; полный server booking regression | PASS |
| UI-AC-12 | full-row checks, compact weekdays, sticky CTA | desktop/mobile Live Window E2E; полный Live Window server regression | PASS |
| UI-AC-13 | сохранены общие `Load`/`Empty`/notice, media fallback локализует ошибку | E2E empty/no-provider/media; визуальная проверка | PASS |
| UI-AC-14 | один `StorefrontView` для preview/public | E2E обеих поверхностей + stage-6 screenshots | PASS |
| UI-AC-15 | UI style хранит только presentation-поля | 78 server tests: booking, reviews, Live Window, loyalty, vouchers | PASS |
| UI-AC-16 | прежние permission-derived nav configs, новый responsive renderer | desktop/mobile owner/client/master E2E | PASS |
| UI-AC-17 | полная доступная локальная регрессия | команды и результаты ниже | PASS |
| UI-AC-18 | реальный Android/iOS MAX WebView | mock MAX не является доказательством | MANUAL |

## Изменения по слоям

- Контракт и данные: Style v2 в `packages/contracts/schemas.ts`; аддитивная миграция `006_storefront_customization.sql` разрешает media purpose `gallery`; JSONB draft/published остаются обратно совместимыми.
- API и безопасность: tenant/purpose-проверки media, нормализация legacy-read, атомарная публикация всех media связей, flag `STOREFRONT_THEMES_V2` через `/config`.
- Owner UI: preset/mode/card controls, порядок секций и галереи, focal point, live mobile/desktop preview, dirty/saved/published states.
- Public UI: три preset, light/dark token map, compact/media service cards, compact/profile staff cards, gallery/lightbox, theme-aware fallbacks.
- Mobile shell: нижняя навигация 4+«Ещё», safe-area, доступный drawer; route PUSH начинает экран сверху.
- Booking/Live Window: визуальный progress обычной записи, sticky primary actions и выровненные кликабельные checkbox-строки без изменения payload.
- Документация: README, FUNCTIONALITY, DATA-API и сгенерированный OpenAPI обновлены.

## Команды и результаты

| Проверка | Результат |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS, Vite production bundle |
| `npm run api:docs` | PASS, 148 endpoints |
| `npm test` на `reviews_full_qa_test` | PASS, 3 files / 78 tests |
| чистая БД: `npm run db:migrate` | PASS, миграции 001…006 |
| повторный migration bootstrap | PASS, без повторного применения |
| `npm run db:seed` | PASS |
| `npm run test:e2e` на отдельной `reviews_e2e_full_test` | PASS, 22/22 desktop+mobile |

Server suite отдельно подтвердил 2/20-way конкуренцию, idempotency, TTL/next candidate, ordinary/manual booking during offer, linked booking, timezone/duration/schedule exceptions, bot-stopped, worker lease recovery, feature flag, RBAC/IDOR, reviews, loyalty, coupons и partnerships.

## Визуальная проверка

Локальные evidence не коммитятся:

- baseline/concepts: `.local/ui-audit-stage5/`;
- итоговые desktop/mobile screenshots: `.local/ui-audit-stage6/`.

Сравнение концепта и реализации:

1. Темы, card variants и live mobile preview размещены в одном рабочем контексте — совпадает; существующий большой экран настроек сохранён, поэтому editor расположен ниже profile/QR, а не заменяет весь экран.
2. Mobile storefront получил hero → CTA → услуги → мастера и нижнюю навигацию — совпадает; визуальные тесты используют технические 1×1 fixture media, поэтому фотографии в evidence намеренно не равны концепту.
3. Четыре primary пункта + «Ещё» и safe-area реализованы — совпадает; нативная iOS/Android полоса жестов проверяется только на устройстве.
4. Сетка service media/profile staff и тёмный editorial preview реализованы — совпадает; плотность типографики продолжает текущий бренд и заметно компактнее концепта.
5. Галерея, reorder и lightbox реализованы — в детерминированном E2E gallery пустая, поэтому итоговый public screenshot её не показывает; API/owner controls и keyboard modal покрыты кодом и интеграционным тестом.
6. Концепт показывает реальные beauty-изображения; реализация не добавляет чужие или сгенерированные production assets и использует безопасные fallbacks.

После сравнения блокирующих визуальных расхождений не найдено. Горизонтального overflow нет на 320/390/768/1440; на 390×844 заголовок, адрес и CTA находятся в первом viewport.

## Ограничения и ручная приёмка

- Не выполнен UI-AC-18: требуется один smoke в реальном MAX на Android и iOS — safe-area, системная клавиатура, MAX BackButton, загрузка фото из галереи устройства.
- Mock MAX проверяет маршрутизацию/back callback и отсутствие console errors, но не поведение нативного WebView chrome.
- Первая итерация не включает свободный CSS/HTML, A/B-эксперименты, произвольные шрифты/цвета или конструктор блоков — это намеренная граница ТЗ.

**Verdict:** UI_EXPERIMENT_READY после фиксации финального commit SHA и push ветки `codex/ui-experiments`; в `main` изменения не сливаются и не деплоятся.
