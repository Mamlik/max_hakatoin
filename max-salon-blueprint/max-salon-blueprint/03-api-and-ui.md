# 03. API, права и экраны

## 1. Стандарт контракта

Префикс `/api/v1`. HTTP JSON, camelCase поля, UUID строки, денежные поля `*Minor`, время UTC ISO 8601. MAX IDs — строки. Никаких неявных преобразований пустой строки в 0 или строки `false` в true. Zod schema strict на входных бизнес-DTO; неизвестные поля отклоняются 422, чтобы ошибочная передача userId/tenantId/price не осталась незамеченной.

Контракты определяются в `packages/contracts/src/<domain>`. Для каждой операции задаются method/path, request/response/error schemas, operationId, разрешённый actor scope и пример. Из реестра генерируются OpenAPI 3.1 и типы клиента; серверные controllers обязаны соответствовать реестру. CI проверяет отсутствие дрейфа. В этом документе — нормативная спецификация маршрутов; настоящий `openapi.json` команда создаёт в задаче CON-01, он здесь не выдаётся за готовый.

```json
{
  "data": {"id": "uuid", "version": 1},
  "meta": {"requestId": "uuid", "serverTime": "2026-09-19T09:00:00Z"}
}
```

```json
{
  "error": {
    "code": "SLOT_UNAVAILABLE",
    "message": "Это время уже занято. Выберите другое.",
    "details": {"retryable": false}
  },
  "meta": {"requestId": "uuid"}
}
```

Lists: `data.items`, `data.nextCursor`; непрозрачный cursor по `(createdAt,id)` или `(startAt,id)`, limit default=30 max=100. Рабочий календарь принимает ограниченный диапазон максимум 31 день; отчёты P0 до 366 дней с отдельным контролем времени запроса. Это технические лимиты проекта. Не возвращать все записи во всех салонах в UI, чтобы он потом отфильтровал.

Команды создают 201, изменения возвращают 200 с новой версией; отсутствие body только для специально описанных 204. Pending replay возвращает 202 и `operationId/pollUrl/retryAfterMs`. `GET /me/operations/{id}` доступен только actor и текущему разрешённому scope. После завершения возвращает статус и исходный результат в envelope.

Изменяющие команды принимают `Idempotency-Key: <UUID v4>`, а изменения существующего объекта — `expectedVersion` в body. Это включает роли, настройки, публикацию, заметки и переходы состояний; можно применить единый механизм шире обязательного минимума ТЗ. Исключения: auth exchange, read marker и upload bytes имеют собственную семантику. Нельзя делать бизнес-изменения GET-запросом.

HTTP-коды:

| Код | Ошибка | Реакция интерфейса |
|---|---|---|
| 401 | AUTH_REQUIRED | Очистить session/private cache, показать повторный вход через MAX |
| 403 | FORBIDDEN | Недостаточная роль в доступном контексте; скрыть запрещённые команды |
| 404 | NOT_FOUND | Чужой/несуществующий непубличный объект одинаково недоступен |
| 409 | STALE_VERSION | Перечитать объект, показать изменения, не повторять автоматически |
| 409 | SLOT_UNAVAILABLE / VOUCHER_UNAVAILABLE | Показать другие слоты/доступные купоны, исходный визит сохранён |
| 409 | CLIENT_OVERLAP_CONFIRMATION_REQUIRED | Предупреждение с отдельным действием продолжения |
| 409 | QUOTE_EXPIRED / QUOTE_CHANGED | Новый quote и подтверждение актуальной суммы/условий |
| 409 | VOUCHER_REMOVAL_CONFIRMATION_REQUIRED | Сравнить старую/новую сумму, дождаться явного согласия |
| 409 | IDEMPOTENCY_KEY_REUSED / IDEMPOTENCY_RESULT_EXPIRED | Не повторять действие; перечитать объект и создать новое намерение |
| 409 | INVALID_STATE_TRANSITION / TENANT_UNAVAILABLE | Показать статус и разрешённое следующее действие |
| 409 | CUSTOMER_LINK_CONFLICT / PARTNER_REVIEW_REQUIRED | Показать объяснение и маршрут разбора владельцем; без автоматической коррекции |
| 422 | VALIDATION_ERROR | Ошибки по path конкретного поля |
| 429 | RATE_LIMITED | Учесть retryAfter; не создавать новый ключ намерения при сетевом повторе |
| 503 | TEMPORARILY_UNAVAILABLE | Безопасно повторить тот же запрос/ключ либо проверить operation |

Локализованные сообщения — для UI; ветвление кода только по `error.code`. Raw SQL/stack/MAX response пользователю не возвращать.

## 2. Права и DTO

`ActorContext` строится на сервере: userId, sessionId, scope personal/work, tenantId из пути/объекта, актуальный membership. Переданные role/header X-Tenant-ID не являются источником доверия. Технический staffId дополнительно связан с membership.

| Действие | Клиент | Мастер | Admin | Owner |
|---|---|---|---|---|
| Публичный каталог/слоты | Да | Да | Да | Да |
| Свои визиты всех салонов | Только свои | В личном режиме | В личном режиме | В личном режиме |
| Рабочий календарь | Нет | Только свои назначения | Весь свой tenant | Весь свой tenant |
| Создать/перенести/отменить | Свои, до начала | Нет | Свой tenant по правилам | Свой tenant по правилам |
| Completed/no_show | Нет | Назначенные, после начала | Свой tenant, после начала | Свой tenant, после начала |
| Исправить исход | Нет | Нет | Нет | Причина + специальные ограничения |
| CRM, заметки, теги | Нет | Нет | Свой tenant | Свой tenant |
| Каталог/график | Нет | Просмотр своего графика | Изменение/архив | Изменение/архив |
| Публикация, оформление | Нет | Нет | Нет | Да |
| Сотрудники, роли | Нет | Нет | Нет | Да, кроме удаления последнего owner |
| Аналитика | Нет | Нет | Операционные метрики | Все метрики |
| Условия партнёрства/отзыв | Свои действия с купоном | Нет | Нет | Только сторона кампании |
| Выбор купона при ручной записи | — | Нет | Для связанного клиента в B | Для связанного клиента в B |
| Аудит | Нет | Нет | Только booking/catalog/schedule/CRM своего tenant | Весь разрешённый журнал своего tenant |

Операционные метрики admin: числа визитов/статусы/неявки/отмены/загрузка/новые и вернувшиеся; service value/average value/партнёрские агрегаты закрыты. Admin видит цену конкретной записи для работы с ней, но не общие финансовые карточки. Это явное уточнение фразы «операционные показатели».

Отдельные DTO: `PublicSalon`, `ClientBooking`, `StaffAssignedBooking`, `AdminBooking`, `OwnerBooking`, `CustomerCard`, `SourceCampaignStats`, `TargetCampaignStats`. `StaffAssignedBooking` содержит bookingId, имя клиента, название услуги, начало/конец, status/version и допустимые действия; в нём **нет** денег, скидки, coupon details, контактов и CRM-notes. Не скрывать эти поля только CSS.

Если owner сам записан как клиент, личная карточка всё равно не включает внутренние заметки. Права интерфейса определяются `allowedActions` для удобства, но сервер повторно проверяет каждую команду.

## 3. Реестр endpoints

Сокращения: P — публичный; U — авторизованный пользователь в личном scope; M — назначенный мастер; A — admin; O — owner. `{t}` всегда tenant UUID, `{b}` booking UUID, `{c}` customer UUID. Все work-методы дополнительно проверяют принадлежность объекта tenant. Таблица перечисляет команды проекта, не API MAX.

### 3.1. Вход, общий кабинет, контекст

| Method path | Scope | Назначение / существенный input |
|---|---|---|
| POST `/auth/max` | initData | `{initData}` → sessionToken, expiresAt, user, launchContext |
| POST `/auth/logout` | U | Отозвать текущую session |
| GET `/me` | U | Профиль, memberships, consent summary, bot channel state |
| PATCH `/me/profile` | U | displayName, expectedVersion; не редактирует CRM-notes |
| PATCH `/me/preferences` | U | partnerProgramEnabled, textVersion, expectedVersion |
| GET `/me/salons` | U | Объединение посещённых/имеющих записи/избранных, с причинами присутствия |
| PUT / DELETE `/me/favorites/{t}` | U | Добавить/убрать избранное, не подписать на маркетинг |
| GET / PATCH `/me/salons/{t}/preferences` | U | partnerAllowed, serviceBotEnabled, reminderBotEnabled, offerBotEnabled, version |
| GET `/me/bookings` | U | from/to, state upcoming/history, optional tenantId, cursor |
| GET `/me/bookings/{b}` | U | Только собственная карточка и allowedActions |
| GET `/me/vouchers` | U | status/tenant/cursor; все личные состояния |
| GET `/me/vouchers/{id}` | U | Snapshot условий без чужой CRM |
| GET `/me/notifications` | U | tenantId/kind/read/cursor |
| PUT `/me/notifications/{id}/read` | U | Идемпотентно отмечает read_at; не меняет MAX delivery |
| GET `/me/operations/{id}` | U | Состояние личной/рабочей команды с перепроверкой scope |
| POST `/launch/resolve` | U | opaque payload → разрешённый маршрут; не создаёт права/запись |

В ответе 202 pollUrl указывает `/api/v1/me/operations/{id}`.

### 3.2. Публичный вход и онбординг

| Method path | Scope | Назначение |
|---|---|---|
| GET `/public/salons?query=...` | P | По точному нормализованному названию/коду только published; без CRM counts |
| GET `/public/salons/{code}` | P | Published revision оформления, адрес, контакты |
| GET `/public/salons/{code}/catalog` | P | Категории, активные услуги и мастера |
| GET `/public/salons/{code}/slots` | P | serviceId, optional staffId, from/to; лимитируем частоту |
| POST `/tenants` | U | name/category/address/timezone/contact → draft + owner |
| GET `/work/{t}/onboarding` | O | Checklist обязательных полей, услуг, мастеров и графика |
| GET / PATCH `/work/{t}/profile` | O | Профиль, version; опубликованный профиль меняется через новую storefront revision |
| GET / PUT `/work/{t}/storefront/draft` | O | templateKey, logo/cover IDs, accentKey, description, categoryOrder, expectedVersion |
| GET `/work/{t}/storefront/preview` | O | Safe rendered config черновика, не публикация |
| POST `/work/{t}/storefront/publish` | O | Версия черновика → опубликованная revision |
| POST `/work/{t}/publish` | O | draft/paused → published, requirements checked |
| POST `/work/{t}/pause` | O | published → paused |
| POST `/work/{t}/archive` | O | Проверить отсутствие обязательств |
| POST `/work/{t}/restore` | O | archived → paused |
| GET `/work/{t}/entry-link` | O | Ссылка и строка для QR |

Первая публикация tenant обязана атомарно опубликовать выбранную storefront revision. Две отдельные кнопки при онбординге не требуются: API может оркестрировать это в `/publish`. Последующие обновления оформления — через `/storefront/publish` без смены tenant status.

### 3.3. Каталог, медиа и график

| Method path | Scope | Назначение |
|---|---|---|
| GET/POST `/work/{t}/categories` | A/O | Список/создание категорий |
| PATCH `/work/{t}/categories/{id}` | A/O | Имя/порядок/version |
| POST `/work/{t}/categories/{id}/archive` | A/O | Архивирование, при активных услугах сначала переназначить категорию |
| GET/POST `/work/{t}/services` | A/O | Каталог/создание |
| PATCH `/work/{t}/services/{id}` | A/O | Имя/цена/длительность/категория/active/version |
| POST `/work/{t}/services/{id}/archive` | A/O | Только новые назначения прекращаются |
| GET/POST `/work/{t}/staff` | A/O | Список/создание мастера |
| PATCH `/work/{t}/staff/{id}` | A/O | Публичные поля и active/version; membership меняет owner отдельно |
| PUT `/work/{t}/staff/{id}/services` | A/O | serviceIds текущего tenant |
| POST `/work/{t}/staff/{id}/archive` | A/O | Сохранить историю/существующие назначения |
| GET `/work/{t}/staff/{id}/schedule` | M/A/O | M только свой; диапазон дат |
| PUT `/work/{t}/staff/{id}/schedule` | A/O | effectiveFrom, weekday work/break intervals, expectedVersion, conflict confirmation |
| PUT/DELETE `/work/{t}/staff/{id}/exceptions/{date}` | A/O | closed/replace, intervals, expectedVersion; удаление возвращает недельное правило |
| POST `/work/{t}/media` | O или A для staff photo | Multipart file+purpose; bytes не через JSON base64 |
| GET `/work/{t}/media/{id}` | O/A по purpose | Авторизованный просмотр draft asset |
| DELETE `/work/{t}/media/{id}` | O/A по purpose | Только неиспользуемый asset; отложенная физическая очистка |

Admin не может менять логотип/обложку; media purpose проверяется сервером. Upload: до 5 MB исходник, JPEG/PNG/WebP, проверка magic bytes и decode, максимум 20 мегапикселей. Перекодировать sharp без EXIF: logo 512×512, cover до 1600×900, staff photo до 800×800; обрезка по выбранной позиции/центру. SVG/HTML/external URL fetch не принимать. Не публиковать оригинал. Имена ключей генерирует сервер, не пользовательский filename.

Статические опубликованные медиа — content-hash URL и immutable cache; черновики — только API с auth. Shared volume монтируется API rw и edge ro; edge не должен иметь маршрут на каталог draft. При публикации отдельная операция делает asset публичным. Неудалённые старые картинки не ломают историю или открытый published revision.

### 3.4. Записи и CRM

| Method path | Scope | Назначение |
|---|---|---|
| POST `/salons/{t}/booking-quotes` | U | Self quote: serviceId, staffId, startAt, optional voucherId |
| POST `/salons/{t}/bookings` | U | Self create: quoteId и подтверждения |
| POST `/me/bookings/{b}/reschedule-quotes` | U | Новый выбор и expectedVersion → условия переноса |
| POST `/me/bookings/{b}/reschedule` | U | quoteId, expectedVersion, warning/removal confirmations |
| POST `/me/bookings/{b}/cancel` | U | expectedVersion, optional reason; только до начала |
| GET `/work/{t}/calendar` | M/A/O | from/to/staffId, M scope принудительно свой |
| GET `/work/{t}/bookings/{b}` | M/A/O | Role-specific DTO |
| POST `/work/{t}/booking-quotes` | A/O | customerId + service/staff/time/voucher |
| POST `/work/{t}/bookings` | A/O | Quote ручной записи; customer в этом tenant |
| POST `/work/{t}/bookings/{b}/reschedule-quotes` | A/O | Quote переноса |
| POST `/work/{t}/bookings/{b}/reschedule` | A/O | Атомарный перенос |
| POST `/work/{t}/bookings/{b}/cancel` | A/O | expectedVersion, reason |
| POST `/work/{t}/bookings/{b}/complete` | M/A/O | expectedVersion; без цены/скидки в body |
| POST `/work/{t}/bookings/{b}/no-show` | M/A/O | expectedVersion |
| POST `/work/{t}/bookings/{b}/correct-outcome` | O | expectedVersion, targetStatus, reason; при восстановлении прежней скидки explicit restorePreviousVoucher и expectedVoucherVersion |
| GET/POST `/work/{t}/customers` | A/O | Поиск/создание ручной карточки |
| GET/PATCH `/work/{t}/customers/{c}` | A/O | Карточка/локальные поля, expectedVersion |
| GET `/work/{t}/customers/{c}/bookings` | A/O | История только текущего tenant |
| GET `/work/{t}/customers/{c}/eligible-vouchers` | A/O | Только применимые у этого tenant купоны связанного user, без исходной услуги A |
| GET/POST `/work/{t}/customers/{c}/notes` | A/O | Внутренние заметки |
| PATCH/DELETE `/work/{t}/customers/{c}/notes/{id}` | A/O | Редактирование/soft delete с аудитом, version |
| GET/POST `/work/{t}/tags` | A/O | Tenant-теги |
| PUT `/work/{t}/customers/{c}/tags` | A/O | Полный набор tagIds в текущем tenant |
| POST `/work/{t}/customers/{c}/link-invites` | A/O | Подтверждаемая ссылка привязки |
| POST `/customer-link-invites/inspect` | U | token → минимальные сведения; токен в body, не access log URL |
| POST `/customer-link-invites/accept` | U | token, explicitConfirmation → candidate |
| POST `/work/{t}/customer-link-invites/{id}/confirm` | A/O | Подтвердить candidate user и связать |
| POST `/work/{t}/customer-link-invites/{id}/revoke` | A/O | Отозвать, не отвязать уже связанную историю |

`POST /salons/{t}/bookings` пример:

```http
Authorization: Bearer <our-session-token>
Idempotency-Key: 54e82c61-9dd9-4d27-8b46-3ea553279189
Content-Type: application/json
```

```json
{
  "quoteId": "8d24f3bb-7b82-4d99-8484-e730d96fb39e",
  "confirmedTermsVersion": "booking-p0-v1",
  "overlapChallengeToken": null,
  "confirmOverlap": false
}
```

Quote — сохранённое серверное намерение, включает всё необходимое. Нельзя прислать произвольную `priceMinor` и ожидать применения. Настройки уведомлений меняются отдельно до confirm либо общей orchestration-командой с явными полями согласия и историей; frontend не считает галочку сохранённой до успешного ответа preferences.

Для reschedule request добавляет `expectedVersion`, `removeVoucher` и подтверждение нового quote. Повтор сетевого запроса использует прежний key. Изменение выбора или подтверждение ранее показанного warning — новое намерение и новый key.

### 3.5. Сотрудники, партнёрство и отчёты

| Method path | Scope | Назначение |
|---|---|---|
| GET `/work/{t}/memberships` | O | Сотрудники/состояние доступа |
| POST `/work/{t}/staff-invites` | O | role, optional staffId/expectedUserId; срок серверный 24h |
| POST `/work/{t}/staff-invites/{id}/revoke` | O | Pending invite отозван |
| POST `/staff-invites/inspect` | U | token → салон, роль, срок |
| POST `/staff-invites/accept` | U | token, explicitConfirmation |
| POST `/work/{t}/memberships/{id}/revoke` | O | expectedVersion, reason; last owner protected |
| PUT `/work/{t}/operational-recipient` | O | membershipId активного owner/admin + tenant version |
| PATCH `/work/{t}/my-notification-preferences` | M/A/O | Свой рабочий канал; только собственное membership |
| PATCH `/work/{t}/partner-settings` | O | enabled, expectedVersion; выключение прекращает новые выдачи/предложения от стороны, обязательства остаются |
| GET/POST `/work/{t}/campaigns` | O | Список своей стороны/новый draft A→B |
| GET `/work/{t}/campaigns/{id}` | O | Состояние и допустимые проекции версий |
| POST `/work/{t}/campaigns/{id}/versions` | O | Новый draft с expectedCampaignVersion |
| PATCH `/work/{t}/campaigns/{id}/versions/{v}` | O | Только draft, expectedVersion |
| DELETE `/work/{t}/campaigns/{id}/versions/{v}` | O | Только draft без согласований/выдач |
| POST `/work/{t}/campaigns/{id}/versions/{v}/propose` | O | Зафиксировать terms и согласие инициатора |
| POST `/work/{t}/campaigns/{id}/versions/{v}/accept` | O | expectedVersion, termsHash, explicitConfirmation |
| POST `/work/{t}/campaigns/{id}/versions/{v}/reject` | O | Вторая сторона, reason optional |
| POST `/work/{t}/campaigns/{id}/versions/{v}/withdraw` | O | Инициатор отзывает proposed в ended |
| POST `/work/{t}/campaigns/{id}/pause` | O | Пауза этой стороны, reason |
| POST `/work/{t}/campaigns/{id}/resume` | O | Снять только собственную паузу |
| POST `/work/{t}/campaigns/{id}/end` | O | Необратимо остановить выдачи |
| GET `/work/{t}/campaigns/{id}/history` | O | Версии/принятия/изменения без чужой CRM |
| POST `/work/{t}/vouchers/{id}/revoke` | O | Свободный issued; reason, expectedVersion |
| POST `/work/{t}/vouchers/{id}/revocation-requests` | O | Reserved: запрос явного снятия скидки |
| GET `/me/voucher-revocation-requests/{id}` | U | Собственная связанная запись, старая/новая сумма |
| POST `/me/voucher-revocation-requests/{id}/respond` | U | accept/decline, expectedBookingVersion, expectedRequestVersion |
| GET `/work/{t}/partner-exceptions` | O | Исключения своей стороны |
| POST `/work/{t}/partner-exceptions/{id}/resolve` | O | Зафиксировать разбор/решение; не менять автоматически деньги/купон |
| GET `/work/{t}/analytics` | A/O | from/to/staffId; role-specific набор показателей |
| GET `/work/{t}/campaigns/{id}/analytics` | O | Cohort выдачи и отдельно визиты B; без чужих клиентов |
| GET `/work/{t}/audit` | A/O | scope/object/type/period/cursor, поля ограничены ролью |
| GET `/work/{t}/delivery-failures` | O или назначенный A | Ошибки сервисных сообщений своего tenant без чужих событий |

`issued_total` и другие внутренние счётчики не доступны для PATCH. Ни один endpoint не устанавливает `status: redeemed` произвольным телом. Изменение состояния — только названная доменная команда.

Для вывода персонального купона B достаточно snapshot разрешённых услуг B/выгоды/срока и подтверждения владельца; поле sourceBookingId в публичном DTO отсутствует. A видит выданный купон как факт своей программы и агрегированный результат, не чужую запись/контакт.

### 3.6. Служебные маршруты

- `POST /integrations/max/webhook` — отдельный секрет, не Bearer session; описание в документе 01.
- `/health/live` — жив ли процесс, без секретов.
- `/health/ready` — доступна ли БД и миграции; Redis degradation отражается отдельно, не запрещает сохранение записи.
- `/internal/metrics` — только внутренняя сеть, без публичного tenant breakdown.
- `/api/openapi.json` — генерируемый контракт без секретных примеров; интерактивная документация в staging для команды/проверяющих.

## 4. Навигация и экраны frontend

### 4.1. Обязательные маршруты

| Route UI | Содержимое и действия |
|---|---|
| `/` | Bootstrap → проверенный launch context или `/me/bookings` |
| `/s/:code` | Бренд, адрес, категории услуг, мастера, записаться, избранное, доступное предложение |
| `/s/:code/book` | Выбор услуги → мастера/любой → дня/слота → server quote → подтверждение |
| `/me/bookings` | Предстоящие/история, календарь с выбором дня, салонный фильтр |
| `/me/bookings/:id` | Карточка, перенос/отмена, повторная запись, исходные/новые условия |
| `/me/salons` | История/избранное, поиск точного названия/кода |
| `/me/offers` | issued/reserved/redeemed/expired/revoked, группировка по салонам |
| `/me/offers/:id` | Условия купона и действие записи в B |
| `/me/events` | Лента, фильтр салона/типа, read и ссылка на объект |
| `/me/profile` | Имя, цель обработки, согласия, настройки по салонам, канал бота |
| `/create-salon` | Форма создания tenant, checklist настройки |
| `/work/:tenant/calendar` | День/неделя, фильтр мастера, свободные/занятые интервалы, действия роли |
| `/work/:tenant/bookings/:id` | Staff/Admin/Owner-вариант карточки, только допустимые действия |
| `/work/:tenant/customers` | Поиск имя/контакт, тег, ручная карточка |
| `/work/:tenant/customers/:id` | Своя история, заметки, теги, запись, процесс привязки |
| `/work/:tenant/catalog` | Категории, услуги, цены/длительность, мастера, архив |
| `/work/:tenant/schedule` | Недельный редактор, перерывы, даты исключений; master только свой просмотр |
| `/work/:tenant/analytics` | Период, мастер, определения метрик, услуги, роль-specific суммы |
| `/work/:tenant/partners` | Включение, поиск салона, список кампаний |
| `/work/:tenant/partners/:id` | Версии, условия, сравнение изменений, согласия, паузы, результат |
| `/work/:tenant/partner-exceptions` | Разбор купонных исключений и запросов отзыва |
| `/work/:tenant/settings` | Профиль, оформление, preview/publish, pause/archive, QR, рабочие уведомления |
| `/work/:tenant/staff-access` | Приглашения, назначение мастера, отзыв и операционный получатель |
| `/work/:tenant/audit` | Журнал с фильтрами, reason и автором |
| `/invite/...` | Принятие staff/link и ценовых подтверждений после auth, без токена в analytics |

Ссылки уведомлений на рабочую/личную карточку разрешает сервер по правам и типу события. Client mode и work mode разделяются явным переключателем с названием салона и ролью. При смене tenant отменяем старые запросы и очищаем selection формы.

### 4.2. Общие правила состояния

Каждый экран имеет loading, empty, error+retry, noAccess, unavailableTenant. Skeleton не подменяет данные нулевыми значениями. Деньги не «мигают» от полной цены к скидке: подтверждение доступно только после quote.

На mutation кнопка disabled до результата; сетевой retry хранит тот же key и body. При 202 показываем «Проверяем результат», опрашиваем operation с паузой 1–2 секунды, не создаём вторую запись. При тайм-ауте нельзя писать «Запись не создана»: сначала проверить результат. При 409 показываем новое состояние и требуем осознанного выбора. Автоповтор mutations с новым ключом запрещён.

Query keys включают `['work',userId,tenantId,resource,...filters]` либо `['personal',userId,...]`. При logout/401/смене user — clear всех приватных данных. Нельзя иметь единственный ключ `['customers']` для разных салонов. Отзыв доступа на открытой странице обнаруживается следующей серверной проверкой; UI прячет устаревшее содержимое после 403/404. Перепроверять при focus/возврате из background.

После собственной команды invalidate booking/calendar/customer/analytics/events/offers в затронутом scope. Рабочий календарь и аналитика refetch каждые 5 секунд только на активном экране; фоновые вкладки не создают постоянную нагрузку. ServerTime позволяет предупреждать о заметно неверных часах устройства; решение о сроках всегда серверное.

### 4.3. Запись — точное поведение

Шаг «Любой мастер» не сохраняется как `staffId=null`: пользователь видит выбранного конкретного мастера до подтверждения. На финальном шаге: салон/адрес, услуга, мастер, дата/зона, длительность, исходная цена, скидка, итог, отмена до начала, настройки сервиса и отдельное участие в партнёрстве.

Пересечение клиента: предупреждение с «Выбрать другое время» и «Всё равно записаться». Занятость мастера: только выбор другого слота. Нельзя использовать один универсальный modal с продолжением для обоих конфликтов.

Повторная запись берёт актуальный каталог: не повторяет старый booking POST/quote. При архивной услуге показываем выбор активных услуг этого салона.

После успеха перейти на карточку созданного bookingId. Внутреннее уведомление доступно сразу. Статус бота «ожидает отправки/принято MAX/не доставлено» отдельно от факта подтверждённой записи; зелёная запись не зависит от внешней доставки.

### 4.4. Оформление и публикация

Один готовый шаблон. Владелец загружает изображения, выбирает акцент из палитры с проверенным контрастом, меняет описание/контакты/категории. Preview использует тот же компонент StorefrontView, что published page; только config отличается. Не создавать отдельную верстку preview, которая может расходиться с реальностью.

«Сохранить черновик» и «Опубликовать» различаются. Проверка обязательных полей показывает конкретный недостающий пункт и ссылку на редактор. Новая категория/услуга с operational active не должна требовать перевыпуска приложения. Сортировка категорий — через согласованную storefront revision, состав каталога — актуальная опубликованная операционная модель.

### 4.5. Согласования

Партнёрская версия показывает «Источник клиентов A» и «Скидку предоставляет B», сумму, услуги каждой стороны, срок выдачи, срок использования и общий лимит. При новой версии показывать изменения по полям. Кнопка «Принять версию N» отправляет termsHash именно этой версии. После stale-version экран обновляется, согласие не переносится молча.

Пауза показывает, какая сторона её поставила; кнопку снять чужую паузу не показываем. Отключение партнёрства предупреждает, что ранее выданные условия продолжают действовать.

Для reserved-отзыва пользователь видит запись, старую/новую сумму, причину и два явных действия. Отказ/закрытие экрана сохраняет условия. Ошибочный completion имеет отдельную owner-форму «Исправить исход» с обязательной причиной; это не обычная форма редактирования визита.

### 4.6. Мобильный и веб-клиент

Проверять ширину 360 px и десктоп. Внизу максимум основные разделы, остальные в «Ещё». Календарь на телефоне — день с карточками/выбором мастера; недельная рабочая сетка доступна с удобным переключением, не требует горизонтального скролла всего приложения. Состояние переключения день/неделя сохраняется локально без персональных данных.

Ввод даты/времени не зависит исключительно от системного picker. BackButton возвращает внутри текущего маршрута; корень закрывает/возвращает в MAX только через поддержанный клиентом путь. Любое действие доступно без камеры, биометрии и системного календаря. Акцент салона не меняет смысл статусов и не ухудшает контраст.

## 5. Примеры запретов для ревью

- `GET /work/A/customers?id=<customerB>` не возвращает пустую «почти карточку» с существующим чужим именем; 404.
- Master endpoint не выполняет `SELECT *` с дальнейшим удалением полей на frontend.
- UI не отправляет `status=completed` произвольным PATCH.
- Купон не имеет «секретного промокода», знание которого заменяет user ownership.
- Отказ от маркетинга не делает форму записи неактивной.
- Внешний MAX API token ни при каких обстоятельствах не оказывается в `VITE_*`, JavaScript bundle, OpenAPI examples или screenshot.
- Готовый экран без доступного endpoint, сохранения и отрицательного сценария не считается реализацией P0.
