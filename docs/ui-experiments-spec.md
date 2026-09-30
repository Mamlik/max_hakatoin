# Техническое задание: UI experiments, итерация 1

**Статус:** ready for implementation

**Версия:** 1.0

**Ветка:** `codex/ui-experiments`

**База:** `origin/main@8ee2e4770977b9a0a08132f523cddcd1be751162`

## 1. Цель

Первая итерация должна дать владельцу безопасный и понятный способ оформить публичную витрину без произвольного HTML/CSS, а клиенту — более компактный mobile-first интерфейс витрины, обычной записи и «Живого окна». Изменения продолжают визуальный язык «рядом»: светлые поверхности, спокойный фиолетовый акцент, редакционная типографика, умеренные скругления и минимум декоративного шума.

Итерация не меняет правила записи, Live Window Lite, отзывы, роли, цены, лояльность, купоны, партнёрства или MAX-доставку. Настройка влияет только на представление уже разрешённых публичных данных.

## 2. Основание и результаты аудита

Аудит выполнен на актуальном `main` в локальной тестовой среде: отдельная БД `reviews_e2e_full_test`, mock MAX, API `127.0.0.1:3240`, Vite `127.0.0.1:5280`. Проверены desktop и ширина 390 px. Локальные evidence и концепты сохранены в игнорируемом каталоге `.local/ui-audit-stage5/` и не входят в коммит.

### Что уже хорошо

- Есть отдельные `draft_style` и `published_style`; публичная витрина меняется только после публикации.
- Есть безопасная загрузка JPEG/PNG/WebP до 5 МБ, удаление метаданных и серверное преобразование в WebP.
- Есть обложка, логотип, четыре акцента, порядок категорий и modal-предпросмотр.
- Desktop-структура, базовые состояния, focus-visible и общая стилистика уже последовательны.

### Проблемы текущего UI

1. Владелец выбирает только акцент и медиа внутри одного фиксированного шаблона; карточки услуг и мастеров не настраиваются.
2. Предпросмотр отделён от контролов и не даёт быстро сравнивать desktop/mobile или видеть сохранённое и опубликованное состояние.
3. На 390 px шапка с переключателем пространства и двухрядная навигация занимают около 175 px; вместе с topbar и отступами содержимое витрины начинается примерно после 300 px.
4. SPA-переход на витрину сохраняет прежний `scrollY`; пользователь может попасть в середину новой страницы.
5. Витрина использует плоский список услуг и одинаковые карточки мастеров независимо от наличия качественных изображений.
6. Нет галереи, контроля фокальной точки обложки и явной проверки качества изображений до публикации.
7. Обычная запись показывает длинную сетку слотов, а Live Window — длинную форму; на мобильном нет устойчивой нижней основной кнопки. Чекбоксы мастеров и дней должны всегда быть кликабельными целыми строками и не зависеть от длины подписи.
8. Светлый режим фактически единственный; тёмная витрина отсутствует.
9. Ошибки, пустые данные и загрузка реализованы неодинаково на разных экранах.

## 3. Объём первого среза

### Обязательно входит

- три готовых безопасных темы витрины;
- светлый и тёмный режим каждой темы через проверенные дизайн-токены;
- два варианта карточек услуг и два варианта карточек мастеров;
- живой desktop/mobile-предпросмотр черновика рядом с настройками;
- явные состояния «есть несохранённые изменения», «черновик сохранён», «опубликовано»;
- публикация только сохранённого черновика с существующей optimistic concurrency;
- порядок разделов `services`, `staff`, `gallery`; hero и основная CTA остаются фиксированными;
- галерея до 8 изображений и фокальная точка обложки;
- компактная мобильная навигация с четырьмя первичными пунктами и «Ещё»;
- обновлённые hero, карточки, контраст и responsive-поведение публичной витрины;
- компактная mobile-first подача обычной записи и формы Live Window без изменения API/доменной логики;
- унифицированные loading/error/empty states;
- восстановление прокрутки в начало при смене маршрута, кроме браузерного Back/Forward;
- keyboard, screen-reader, reduced-motion и WCAG 2.2 AA проверки;
- тесты контрактов, tenant isolation, draft/publish и desktop/mobile E2E.

### Не входит в первую итерацию

- произвольные CSS, HTML, JavaScript, шрифты или URL владельца;
- свободный color picker и пользовательские цветовые пары;
- конструктор блоков, разные страницы, рекламные баннеры, видео, анимационный редактор;
- A/B-тестирование, метрики конверсии тем и автоматический выбор победителя;
- AI-генерация дизайна или изображений;
- индивидуальные шаблоны конкретной услуги/мастера;
- изменение навигации desktop-кабинета и бизнес-логики форм;
- изменение исходных файлов изображений после загрузки; применяется только безопасный crop/focal-point при показе.

## 4. UX-принципы

1. **Сначала содержимое.** На 390×844 hero и CTA должны быть видны в первом экране; глобальная навигация не конкурирует с витриной.
2. **Безопасная выразительность.** Владелец комбинирует только заранее проверенные пресеты и варианты компонентов.
3. **Черновик без риска.** Все контролы меняют локальный draft preview. Публичный endpoint продолжает читать только `published_style`.
4. **Доступность по умолчанию.** Нельзя создать комбинацию с недостаточным контрастом или скрыть критическую информацию о цене, длительности и записи.
5. **Одинаковые правила на всех размерах.** Тема меняет токены и вариант представления, но не порядок действий и не семантику данных.

## 5. Темы и дизайн-токены

Доступные `themePreset`:

| ID | Название в UI | Характер |
|---|---|---|
| `studio` | Студия | спокойная, минимальная, близка к текущему интерфейсу |
| `editorial` | Редакция | более выразительная обложка и ритм карточек, без декоративной перегрузки |
| `noir` | Нуар | контрастная премиальная подача с тёмными поверхностями |

`colorMode`: `light` или `dark`. `accent` остаётся одним из `violet`, `rose`, `teal`, `amber`. Каждая комбинация разрешена только через статическую карту токенов: `surface`, `surfaceElevated`, `text`, `muted`, `border`, `accent`, `accentText`, `focus`, `success`, `danger`. Владельцу не передаются hex/CSS-поля.

Для всех 24 комбинаций preset × mode × accent обязательны:

- контраст обычного текста не ниже 4.5:1, крупного — 3:1;
- контраст UI-компонентов и focus ring не ниже 3:1;
- CTA имеет читаемую пару фон/текст;
- системная `prefers-reduced-motion` отключает необязательные переходы;
- `color-scheme` соответствует выбранному режиму внутри витрины и preview, не меняя рабочий кабинет.

## 6. Модель настроек

Хранение остаётся в существующих JSONB `tenants.draft_style` и `tenants.published_style`. Для самой структуры JSONB SQL-миграция не требуется; аддитивная миграция расширяет существующий `media_assets_purpose_check` значением `gallery`. Контракт расширяется обратно совместимо; чтение старой структуры проходит через единый `normalizeStyle` и получает defaults.

```ts
type StorefrontStyleV2 = {
  schemaVersion: 2;
  accent: "violet" | "rose" | "teal" | "amber";
  description: string;
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  categoryOrder: string[];
  themePreset: "studio" | "editorial" | "noir";
  colorMode: "light" | "dark";
  coverFocalPoint: { x: number; y: number }; // 0..100
  serviceCards: {
    variant: "compact" | "media";
    showDescription: boolean;
  };
  staffCards: {
    variant: "compact" | "profile";
    showDescription: boolean;
    showRating: boolean;
  };
  sectionOrder: Array<"services" | "staff" | "gallery">;
  galleryMediaIds: string[]; // unique, max 8
};
```

Defaults для v1: `studio`, `light`, `{x:50,y:50}`, compact-карточки, все описания и рейтинг включены, порядок `services,staff,gallery`, пустая галерея. Неизвестные поля отклоняются на write, неизвестные enum — безопасно нормализуются только на legacy read.

### Валидация и безопасность

- `galleryMediaIds` уникальны, максимум 8, принадлежат текущему tenant и имеют purpose `gallery`.
- Upload endpoint получает новый purpose `gallery`; разрешён owner/admin, формат и лимит остаются прежними. Сервер поворачивает изображение, удаляет метаданные, сохраняет WebP, ограничивает 20 MP и вписывает до 1600×1200 без увеличения.
- `coverFocalPoint.x/y` — конечные числа 0..100; используются только как `object-position`.
- `sectionOrder` содержит каждый из трёх идентификаторов ровно один раз. Пустой раздел на публичной витрине не рендерится, но порядок сохраняется.
- `showRating` не раскрывает дополнительные данные: используется существующий безопасный агрегат рейтинга.
- Draft/preview доступны только owner текущего tenant; public endpoint отдаёт только published style и опубликованные/связанные assets.
- Никакой ввод владельца не попадает в `dangerouslySetInnerHTML`, inline CSS-строки или URL-загрузки.

## 7. API и публикация

Существующие маршруты сохраняются:

- `GET /api/v1/work/:t/storefront/draft`;
- `GET /api/v1/work/:t/storefront/preview`;
- `PUT /api/v1/work/:t/storefront/draft` с `expectedVersion` и `style: StorefrontStyleV2`;
- `POST /api/v1/work/:t/storefront/publish` с `expectedVersion`;
- `GET /api/v1/public/salons/:code`.

`PUT draft` валидирует все media/category references внутри одной tenant-транзакции и пишет audit `storefront.draft`. `publish` атомарно копирует нормализованный draft в published style, сохраняет существующую проверку версии и audit `storefront.published`. При 409 UI сохраняет локальные изменения, сообщает, что оформление изменилось в другой сессии, и предлагает перезагрузить/сравнить; автоматического overwrite нет.

Public asset endpoint разрешает только media, реально достижимые из published style/catalog. Preview использует защищённые tenant-scoped URLs.

OpenAPI, DATA-API, README и FUNCTIONALITY обновляются вместе с реализацией.

## 8. Экран владельца

Маршрут настроек сохраняется. Блок «Оформление витрины» превращается в самостоятельный редактор.

### Desktop ≥ 1024 px

- Верхняя строка: breadcrumb, статус публикации, «Посмотреть опубликованную», split-action «Сохранить черновик» / «Опубликовать».
- Основная область: настройки слева/по центру и sticky preview справа шириной 360–420 px.
- Секции контролов: тема; карточки услуг; карточки мастеров; порядок разделов; галерея; обложка и фокус.
- Preview переключается `Мобильный / Desktop` и всегда использует локальный draft, включая ещё не сохранённые изменения.
- Подпись состояния различает `Несохранённые изменения`, `Черновик сохранён`, `Опубликовано <дата/время>`.

### Mobile < 768 px

- Контролы идут одной колонкой.
- Sticky нижняя панель содержит «Предпросмотр» и «Сохранить» с учётом `env(safe-area-inset-bottom)`.
- Preview открывается полноэкранной панелью, имеет корректный focus trap, `aria-modal`, явное закрытие и переключатель размера.
- Публикация требует короткого подтверждения с перечислением изменённых групп, но не отдельного сетевого запроса до финального действия.

### Контролы

- Preset — три визуальные radio-карточки с миниатюрой и текстовым названием.
- Mode и card variants — `fieldset`/`legend` + radio, не кликабельные `div`.
- Порядок разделов — клавиатурные кнопки вверх/вниз обязательны; drag-and-drop допустим как дополнение.
- Галерея — upload, reorder, remove from draft. Удаление связи не удаляет asset физически.
- Фокус обложки — кликабельный/клавиатурный preview с видимой рамкой и reset 50/50.

## 9. Публичная витрина

### Hero

- Mobile hero начинается сразу после компактного контекстного header; на 390×844 видны имя, адрес и CTA без прокрутки.
- Обложка имеет безопасный scrim, если поверх неё расположен текст; alt зависит от смысла: декоративная — пустой alt, информативная — «Обложка салона …».
- При отсутствующей/не загрузившейся обложке используется тематический token fallback, а не чёрный прямоугольник.
- `object-position` задаётся `coverFocalPoint`.

### Карточки услуг

- `compact`: текстовая строка/карточка, цена и действие справа, изображение опционально.
- `media`: изображение 4:3, название, длительность, цена, описание по флагу.
- Цена, длительность и доступность действия не могут быть скрыты темой.

### Карточки мастеров

- `compact`: аватар, имя, рейтинг, короткая роль/описание.
- `profile`: вертикальная карточка с более крупным фото, описанием и рейтингом.
- При отсутствии фото — предсказуемый monogram fallback с достаточным контрастом.

### Галерея

- Mobile: горизонтальная scroll-snap лента; desktop: сетка, максимум 4 превью + «ещё N».
- Открытие lightbox поддерживает клавиатуру, Escape, focus return и swipe без обязательной анимации.
- Пустая галерея полностью скрывает раздел.

## 10. Компактная мобильная навигация

На ширине < 768 px текущая двухрядная навигация заменяется:

- компактным header 56–64 px: бренд/назад, текущий контекст, события;
- нижней навигацией 4 первичных действия + `Ещё`, высота не более 72 px с safe-area;
- drawer `Ещё` содержит оставшиеся маршруты, переключатель пространства, создание салона и выход.

Набор primary зависит от контекста, но маршруты и права не меняются:

- клиент: Главная/салоны, Мои записи, Живое окно, Профиль, Ещё;
- рабочий кабинет: Календарь, Клиенты, Каталог, Настройки, Ещё.

Активный пункт имеет не только цвет, но и форму/иконку плюс доступное имя. Никакого горизонтального overflow. Route transition прокручивает новый экран к началу; browser Back/Forward восстанавливает прежнюю позицию.

## 11. Обычная запись и Live Window

Доменная логика, payload и endpoint не меняются. Меняется только композиция.

### Обычная запись

- Шаги: `Услуга и мастер` → `Дата и время` → `Подтверждение`; на mobile показывается компактный progress, завершённые шаги можно раскрыть.
- После выбора услуги сверху виден summary с длительностью, ценой и мастером.
- Даты представлены доступной горизонтальной лентой; timezone подписан рядом.
- Слоты — сетка без вложенного чрезмерно высокого scroll area; при большом списке используются группировка по частям дня и `content-visibility: auto`.
- Финальное действие sticky снизу, не перекрывает последний слот и учитывает клавиатуру/safe-area.

### Live Window

- Первым блоком показано: «Это запрос ожидания, а не запись» и отсутствие удержания слота.
- Выбор мастеров — целиком кликабельные строки не меньше 44 px; checkbox и подпись имеют постоянный gap 10–12 px. Длинное имя переносится рядом с checkbox, а не уезжает вправо.
- Дни недели — нативные checkbox внутри компактных label; визуальное состояние не зависит только от цвета.
- Даты, диапазон времени и notice сгруппированы; основная кнопка sticky на mobile.
- Ошибки привязаны к полю через `aria-describedby`; первый invalid control получает focus.

## 12. Loading, error и empty states

Создать общие компоненты `PageSkeleton`, `InlineError`, `SectionEmpty`, `MediaFallback`:

- skeleton повторяет геометрию hero/card и отключает анимацию при reduced motion;
- error содержит понятное действие «Повторить», технический ID только при наличии;
- empty объясняет следующий шаг и не предлагает действие без прав;
- падение одного изображения не превращает весь раздел в ошибку;
- preview не теряет введённый draft при ошибке сохранения.

## 13. Компоненты и границы реализации

Рекомендуемая декомпозиция:

- `StorefrontThemeProvider` — только token mapping;
- `normalizeStorefrontStyle` — единственная точка legacy defaults;
- `StorefrontEditor`, `ThemePresetPicker`, `CardVariantPicker`, `SectionOrderEditor`, `GalleryEditor`, `CoverFocalPointEditor`;
- `StorefrontPreview` переиспользует production-компоненты, а не отдельную копию разметки;
- `StorefrontHero`, `ServiceCards`, `StaffCards`, `StorefrontGallery`;
- `MobileAppHeader`, `MobileBottomNav`, `MoreNavigationSheet`;
- `BookingProgress`, `BookingSelectionSummary`, `WaitlistPreferenceForm`.

Desktop-sidebar и текущая desktop topbar остаются. Бизнес-hooks и API вызовы не дублируются в визуальных компонентах.

## 14. Производительность React

- Не создавать последовательные fetch-waterfalls: style, catalog и media metadata грузятся параллельно существующими hooks.
- Preview получает готовый model и использует те же presentational components; сетевые запросы при каждом выборе пресета запрещены.
- Локальный draft хранится единым объектом; обработчики используют functional updates, а производные flags вычисляются в render/useMemo только при измеримой пользе.
- Тяжёлый lightbox и необязательный desktop preview загружаются динамически; редактор не попадает в публичный bundle.
- Перестановка/выбор темы помечается как non-urgent (`startTransition`/`useDeferredValue`) только если profiling показывает задержку ввода.
- Списки используют стабильные ID keys; gallery thumbnails имеют размеры, `loading=lazy` и предотвращают layout shift.
- Длинные публичные секции применяют `content-visibility: auto`; изображения имеют responsive `sizes`.
- Новая зависимость UI-библиотеки не добавляется без доказанной необходимости; базовые controls реализуются семантическим HTML и текущими icon primitives.

## 15. Accessibility

- WCAG 2.2 AA для всех тем и состояний.
- Touch target не меньше 44×44 px; расстояние между соседними маленькими целями не меньше 8 px.
- Все icon-only кнопки имеют доступное имя; heading hierarchy не перескакивает.
- Видимый focus не скрывается sticky header/footer; modal/sheet удерживает focus и возвращает его источнику.
- Radio/checkbox имеют `fieldset`, `legend`, связанный label и читаемое checked-состояние.
- Drag-and-drop всегда имеет кнопочный и screen-reader эквивалент.
- Toast не является единственным каналом результата: используется `aria-live` и постоянный статус черновика.
- Изменение темы не вызывает неожиданного focus/scroll reset.

## 16. Acceptance criteria

| ID | Критерий |
|---|---|
| UI-AC-01 | Legacy style из текущей БД нормализуется в v2 без миграции и публичная витрина визуально остаётся рабочей. |
| UI-AC-02 | Владелец выбирает любой из 3 preset, light/dark, существующий accent и два варианта service/staff cards; preview обновляется без сети. |
| UI-AC-03 | Несохранённый preview, сохранённый draft и опубликованная витрина различимы; public endpoint не показывает draft до publish. |
| UI-AC-04 | Конфликт `expectedVersion` не перезаписывает чужой draft и не теряет локальные изменения UI. |
| UI-AC-05 | Tenant A не может ссылаться на category/media tenant B; gallery принимает только 0–8 уникальных tenant-owned gallery assets. |
| UI-AC-06 | Обложка использует focal point, fallback не чёрный, gallery reorder и section reorder одинаковы в preview и после publish. |
| UI-AC-07 | Все 24 token-комбинации проходят автоматическую проверку минимального контраста для текста, CTA, borders и focus. |
| UI-AC-08 | На 390×844 имя салона, адрес и CTA видны в первом viewport; нет горизонтального overflow на 320, 390, 768 и 1440 px. |
| UI-AC-09 | Mobile nav содержит 4 primary + «Ещё», все существующие разрешённые маршруты достижимы, активный пункт объявлен screen reader. |
| UI-AC-10 | Новый SPA-маршрут начинается с `scrollY=0`, а Back/Forward восстанавливает сохранённую позицию. |
| UI-AC-11 | Обычная запись сохраняет те же quote/booking payload и результат; sticky CTA не перекрывает controls на iOS/Android safe-area. |
| UI-AC-12 | Live Window отправляет прежний payload; master/weekdays labels прилегают к controls, целиком кликабельны и работают клавиатурой. |
| UI-AC-13 | Loading/error/empty/image-failure состояния не ломают layout и дают доступный следующий шаг. |
| UI-AC-14 | Preview и публичная витрина используют общие компоненты; snapshot/visual проверки подтверждают соответствие одной модели. |
| UI-AC-15 | Theme/card/gallery настройки не меняют цену, длительность, рейтинг, availability, RBAC или бизнес-логику. |
| UI-AC-16 | Owner/admin/master/client видят только положенную навигацию до и после responsive refactor. |
| UI-AC-17 | Build, typecheck, полный server suite и существующий desktop/mobile E2E остаются зелёными. |
| UI-AC-18 | Реальный MAX WebView smoke вручную проверяет safe-area, back button, keyboard и отсутствие перекрытия нижней навигации. |

## 17. Тестовая матрица

### Unit / contracts

- `normalizeStorefrontStyle`: v1, частичный v2, invalid enum, defaults, stable serialization;
- Zod: strict fields, x/y bounds, exact section set, duplicate/9 gallery IDs;
- token contrast test всех 24 комбинаций;
- route-scroll state: push vs popstate;
- navigation config по роли/контексту.

### Server / integration

- draft save → preview → public до publish → publish → public после publish;
- repeat save/publish и stale `expectedVersion`;
- tenant/IDOR для draft, preview, gallery upload/read/reference;
- public media allowlist для draft-only asset;
- legacy seeded tenant и clean DB bootstrap;
- gallery image type/size/corrupt/20 MP and metadata stripping;
- отсутствие изменений обычного booking, reviews aggregate и Live Window payload.

### Component / accessibility

- keyboard: theme picker, section controls, gallery, preview sheet, nav drawer;
- focus trap/return, aria-live save status, invalid field focus;
- long salon/master/service names, empty description, no images, broken image;
- reduced motion и high zoom 200%.

### E2E / visual

Viewports: 320×568, 390×844, 768×1024, 1440×900. Для `studio/light`, `editorial/light`, `noir/dark`:

1. owner edits theme/cards/order/gallery/focal point, previews mobile/desktop, saves, publishes;
2. another session creates version conflict;
3. client opens storefront, gallery, service, staff rating and booking;
4. ordinary booking complete smoke;
5. Live Window create request smoke with long master name and weekdays;
6. all client/owner/admin/master navigation destinations reachable;
7. refresh/direct link and SPA transition scroll behavior;
8. skeleton/error/empty and failed media request.

Visual snapshots use deterministic fixture images, not 1×1 technical uploads. Pixel snapshots supplement, but do not replace semantic assertions.

### Manual MAX smoke

- Android and iOS MAX WebView: safe-area, keyboard, viewport resize, system Back/MAX BackButton;
- light/dark system chrome around mini-app;
- upload from device gallery and server crop;
- screen-reader smoke where available.

Manual checks are reported separately and are not marked passed by mock MAX.

## 18. Порядок реализации этапа 6

1. Style v2 normalization, contracts, token map, upload `gallery`, server tests.
2. Shared storefront components, three presets, card variants, hero/focal point, gallery.
3. Owner editor, live preview, draft/publish/conflict UX.
4. Compact mobile navigation and scroll restoration.
5. Booking/Live Window composition and shared states without payload changes.
6. Accessibility, responsive/visual E2E, full regression and documentation.

После каждого milestone запускаются typecheck, relevant tests и build. Финальный commit допускается только при выполнении автоматизируемых UI-AC; ручной MAX smoke фиксируется отдельным ограничением.

## 19. Rollout и обратная совместимость

- Изменения аддитивны и не требуют SQL migration; старые JSON style читаются с defaults.
- Реализация ставится под env/config feature flag `STOREFRONT_THEMES_V2`; при off используется текущий renderer и текущий editor.
- V2 можно включать по tenant allowlist в non-production. Публикация v2 не удаляет legacy fields.
- Rollback flag возвращает legacy renderer без потери draft/published JSON.
- Production, домен, секреты и деплой не входят в этап 6.

## 20. Definition of Done

- Все обязательные элементы раздела 3 реализованы без изменения бизнес-правил.
- UI-AC-01…17 имеют автоматизированное доказательство и проходят; UI-AC-18 честно отмечен manual.
- Нет новых typecheck/build/server/E2E failures.
- OpenAPI/DATA-API/README/FUNCTIONALITY описывают v2 style, темы, галерею и публикацию.
- Implementation report связывает каждый UI-AC с кодом и тестом.
- Ветка остаётся `codex/ui-experiments`; main не изменяется и ничего не деплоится.
