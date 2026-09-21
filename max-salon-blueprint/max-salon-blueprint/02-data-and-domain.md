# 02. Данные, транзакции и фоновые процессы

## 1. Общие соглашения

Все внутренние ID — UUID, снаружи строки. Время события — PostgreSQL `timestamptz`, в API ISO 8601 с `Z`. MAX user/chat ID — PostgreSQL bigint, в TypeScript/API decimal string. Локальная дата графика — `date`, локальное время — `time`, зона — IANA (`Europe/Moscow`), а не просто `+03:00`.

Деньги — целые копейки (`integer`, в API `priceMinor`), валюта P0 только RUB. `100000` означает 1000 ₽. Не использовать float/decimal в JavaScript для расчётов. Итог = снимок цены − согласованная скидка; `0 ≤ discountMinor ≤ priceMinor`. Нельзя молча уменьшить слишком большую скидку: неподходящую услугу/купон отклоняем.

`version` — положительный integer, увеличивается при каждом изменении агрегата. История append-only. Все интервалы `[start, end)`: 10:00–11:00 и 11:00–12:00 совместимы. В одной записи одна услуга и один мастер. Клиентское `endAt`, цена, роль и скидка не считаются доверенными: сервер выводит их из каталога, снимка или проверенного quote.

Термины: `user` — общий аккаунт, `customer` — карточка клиента одного салона, `staff` — публичный мастер, `membership` — право пользователя работать в салоне. Не объединять эти таблицы. Мастер может существовать без MAX-аккаунта; MAX-пользователь может иметь карточки в разных салонах.

Единые enum в `packages/contracts`:

| Имя | Значения |
|---|---|
| TenantStatus | draft, published, paused, archived |
| BookingStatus | confirmed, completed, cancelled, no_show |
| WorkRole / MembershipStatus | owner, admin, master / active, revoked |
| CampaignStatus | draft, proposed, active, rejected, paused, ended |
| CampaignVersionStatus | draft, proposed, active, rejected, ended |
| VoucherStatus | issued, reserved, redeemed, expired, revoked |
| InviteStatus | pending, accepted, revoked, expired |
| CustomerLinkInviteStatus | pending, client_confirmed, accepted, revoked, expired |
| BotChannelState | unknown, active, stopped, removed |
| DeliveryState | scheduled, sending, retry_wait, sent, suppressed, failed |

CampaignStatus описывает весь договор: при наличии active_version новая предложенная версия не переводит кампанию обратно в proposed. Паузы хранятся у кампании, у версии отдельного paused нет. Когда договор завершается, его выдающая версия тоже становится ended. `client_confirmed` — внутренний дополнительный этап двухсторонней привязки CRM, не выданный доступ. Новые enum-значения добавляются только с переходом состояния, контрактом и тестом.

## 2. Физическая модель

Ниже обязательные таблицы и существенные поля; `id/created_at/updated_at` не повторяются в каждой строке. Это проект схемы, а не готовая миграция. `jsonb` допускается для неизменных снимков и внешнего payload, но не вместо нормализованных связей/сумм/времени.

### 2.1. Личность, доступ и настройки

| Таблица | Существенные поля и ограничения |
|---|---|
| `users` | `max_user_id UNIQUE`, `display_name`, `profile_version`, `partner_program_enabled=false`, `preferences_version`, `is_test`; внешнее имя не выдаёт прав |
| `sessions` | `user_id`, `token_hash UNIQUE`, `auth_date`, `expires_at`, `revoked_at`; TTL не продлевается активностью |
| `tenants` | `public_code UNIQUE`, name/category/address/timezone/contact, status, version, `operational_recipient_membership_id`, `partner_enabled=false` |
| `memberships` | `tenant_id,user_id,role,status,version`; UNIQUE(tenant_id,user_id), role owner/admin/master. Один основной рабочий role в tenant в P0 |
| `staff_invites` | tenant, role admin/master, optional staff_id, token_hash UNIQUE, expected_user_id nullable, expires_at, status, accepted_by, version |
| `customer_link_invites` | tenant, customer_id, token_hash, expires_at, status, candidate_user_id, confirmed_by_customer_at, confirmed_by_staff_at |
| `tenant_user_preferences` | UNIQUE(user_id,tenant_id), `partner_allowed=false`, `service_bot_enabled=false`, `offer_bot_enabled=false`, `reminder_bot_enabled=false`, version |
| `work_notification_preferences` | membership_id UNIQUE, `enabled=false`; проверяется вместе с актуальным membership |
| `consent_history` | user_id, optional tenant, field, before/after, text_version, source, actor, recorded_at; без перезаписи старых фактов |
| `bot_channels` | UNIQUE(bot_id,user_id), max_chat_id nullable, state, `last_event_at_ms`, last_event_rank, `generation`, muted nullable |
| `favorite_salons` | PRIMARY KEY(user_id,tenant_id), created_at; избранное не равно согласию |

`reminder_bot_enabled` — техническое уточнение настройки напоминаний из ТЗ: при включении формы «сообщения о записи и напоминания» явно устанавливаются service и reminder; затем reminder можно отключить отдельно. Никакие значения не включаются из одного только факта записи.

`tenant.partner_enabled` отвечает за добровольность бизнеса; `user.partner_program_enabled` — за клиента. Это разные переключатели. Публичный поиск партнёра не должен раскрывать CRM.

### 2.2. Витрина, каталог, график, CRM

| Таблица | Поля и ограничения |
|---|---|
| `storefront_revisions` | tenant, revision, draft/published, template_key, logo_media_id, cover_media_id, accent_key, description, ordered_category_ids, snapshot public profile |
| `tenants` (ссылки оформления) | `draft_storefront_revision_id`, `published_storefront_revision_id`; публикация атомарно переключает указатель |
| `media_assets` | tenant, key UNIQUE, purpose logo/cover/staff, mime, width/height, size, status draft/published, uploader |
| `service_categories` | tenant, name, sort_order, archived_at |
| `services` | tenant, category_id, name, description, duration_min, price_minor, currency, active, archived_at, version |
| `staff` | tenant, name, description, photo_media_id, membership_id nullable, active, archived_at, schedule_version |
| `staff_services` | PRIMARY KEY(tenant_id,staff_id,service_id), только совместимые tenant |
| `schedule_rules` | tenant, staff, effective_from/to (локальные даты), weekday 1–7, version |
| `schedule_rule_intervals` | rule_id, kind work/break, local_start/end; интервалы одного типа не пересекаются |
| `schedule_exceptions` | tenant, staff, date, mode closed/replace, version; UNIQUE(staff_id,date) |
| `schedule_exception_intervals` | exception_id, kind work/break, local_start/end |
| `schedule_day_snapshots` | tenant, staff, local_date, timezone, schedule_revision, effective UTC available ranges, available_minutes, frozen_at; UNIQUE(staff_id,local_date) |
| `customers` | tenant, user_id nullable, display_name, optional_contact, contact_purpose, first_source, version, is_test |
| `customer_notes` | tenant, customer, body, author_membership_id, version; edits журналируются, текст не попадает в события бота |
| `tags` / `customer_tags` | tenant, name / tenant,customer_id,tag_id; уникальность тега внутри tenant |

Для `customers` — partial UNIQUE(tenant_id,user_id) WHERE user_id IS NOT NULL. Разные ручные карточки могут иметь одинаковый телефон или имя; это не основание для слияния. Поля первого/последнего completed-визита и число визитов — вычисляемые проекции, не редактируемые данные клиента.

Недельное правило действует с локальной даты. Исключение `closed` закрывает день; `replace` полностью заменяет недельные интервалы этого дня. В P0 интервалы внутри одного локального дня; ночную смену задаём двумя интервалами соседних дней. Запрет пересечений break/work внутри шаблона проверяется до сохранения.

### 2.3. Записи и партнёрство

| Таблица | Поля и ограничения |
|---|---|
| `bookings` | tenant, customer_id, user_id nullable, staff_id, service_id, start_at/end_at, timezone_snapshot, status, version, source self/manual, created_by, service_name_snapshot, duration_snapshot, price_minor_snapshot, discount_minor, applied_voucher_id nullable, quote_id, outcome_at |
| `booking_revisions` | tenant, booking_id, version UNIQUE в записи, actor, reason, before/after approved snapshot, changed_at |
| `booking_warning_challenges` | actor, target_tenant, normalized_intent_hash, conflicts_fingerprint, expected_booking_version, quote_id, expires_at, token_hash; не хранить открытые чужие детали в ответе staff |
| `booking_quotes` | actor, tenant, customer binding, service/staff, start/end, price, discount, referenced versions, signature/hash, expires_at; срок 5 минут |
| `campaigns` | source_tenant_id A, target_tenant_id B, status, active_version_id, pending_version_id, `issued_total`, version; A ≠ B |
| `campaign_versions` | campaign_id, number, status, source_service_ids, target_service_ids, discount_minor, issue_from/until, voucher_valid_days, issue_limit, terms_text, terms_hash; UNIQUE(campaign_id,number) |
| `campaign_acceptances` | campaign_id, version_id, tenant_id, owner_user_id, accepted_at, terms_hash; UNIQUE(version_id,tenant_id) |
| `campaign_pauses` | campaign_id, tenant_id, paused_by, paused_at; UNIQUE(campaign_id,tenant_id); снимает только эта сторона |
| `vouchers` | campaign_id, version_id, source_booking_id, source_customer_id, user_id, source_tenant_id, target_tenant_id, status, issued_at, expires_at, reserved_booking_id nullable, redeemed_booking_id nullable, immutable terms_snapshot, version |
| `voucher_revisions` | voucher_id, version, action, actor, reason, time, booking reference |
| `partner_exceptions` | campaign/voucher/source_booking/target_booking refs, type, minimal evidence, status open/resolved, resolution_note, actor; персональные поля выдаются только в разрешённой проекции |
| `voucher_revocation_requests` | voucher, booking, owner_actor, reason, current_price, proposed_price, expected_booking_version, expires_at, status; для явного согласования снятия скидки |

Нормализовать наборы услуг кампании отдельными таблицами `campaign_version_source_services` и `campaign_version_target_services`; выше сокращённая запись полей. Каждая связь проверяет правильную сторону A/B. Снимок купона содержит только условия выгоды и ссылки для внутреннего учёта; API B никогда не отдаёт услугу-основание или CRM A.

Ключ выдачи: UNIQUE(user_id,source_booking_id,campaign_id). Также UNIQUE(source_customer_id,source_booking_id,campaign_id) допустим как дополнительная защита; source_booking однозначно определяет customer. Смена версии кампании этот ключ не меняет.

Один купон на запись: partial UNIQUE(applied_voucher_id) в текущих привязках, где applied_voucher_id IS NOT NULL. Один активный резерв купона — собственная строка vouchers с reserved_booking_id и блокировкой. При снятии резерва booking.applied_voucher_id очищается, скидка пересчитывается по подтверждённой цене, история сохраняется отдельно. У redeemed привязка остаётся навсегда, обычного «отменить использование» нет.

### 2.4. Надёжность и события

| Таблица | Поля и ограничения |
|---|---|
| `idempotency_operations` | actor, scope_key, operation_type, key UUIDv4, request_hash, request_json (минимальное нормализованное намерение), expected_version, state pending/succeeded/rejected, lease_until, fence, status_code, response_json, result_refs, completed_at, response_until, key_until |
| `audit_log` | event_id, tenant, actor/user/role snapshot, object_type/id, action, changed_fields, result, reason, occurred_at, correlation_id |
| `outbox_events` | event_id UUID UNIQUE, type, schema_version, aggregate_id/version, primary_tenant, occurred_at, minimal payload, publish_state, lease_until |
| `event_consumptions` | PRIMARY KEY(consumer_name,event_id), processed_at; независимый dedup для каждого consumer |
| `max_inbox` | bot_id, event_key UNIQUE в боте, update_type, external_timestamp_ms, redacted/limited payload, received_at, processed_at, attempts, lease_until |
| `notifications` | recipient_user_id, tenant_id, event_id, kind, object_ref, safe_snapshot, read_at; UNIQUE(recipient_user_id,event_id,kind) |
| `notification_deliveries` | notification_id, channel max, target_user_id, channel_generation, state, object_version, due_at, not_after, attempts, next_attempt_at, lease_until, fencing_token, max_message_id, last_error_code |
| `delivery_attempts` | delivery_id, attempt_no, started_at/finished_at, response_status, result sent/temporary/permanent/unknown; тело сообщения не копировать в лог |

`scope_key` — непустая строка `tenant:<uuid>`, `user:<uuid>` или `platform:create-tenant`, вычисляется сервером. Не использовать nullable tenant в unique-ключе идемпотентности: SQL NULL может позволить дубликаты. UNIQUE(actor,scope_key,operation_type,key).

## 3. Ограничения базы и индексы

Для каждой tenant-таблицы: `tenant_id NOT NULL`, FK на tenants, UNIQUE(tenant_id,id). Межтабличные связи — составные FK `(tenant_id,customer_id) → customers(tenant_id,id)`, аналогично staff/service/note/tag/media. Это ловит случай, когда код проверил URL tenant, но записал service_id чужого салона.

Ссылки campaigns/vouchers межсалонные намеренно: у них две стороны и отдельный repository. Не пытаться маскировать их фиктивным tenant_id. Доступ определяется source/target и ролью, а выдаваемый DTO — выбранной стороной.

Запрет пересечения мастера делаем в PostgreSQL, а не только `SELECT свободно` в коде. Схематический SQL после создания таблицы:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings
  ADD CONSTRAINT booking_time_valid CHECK (end_at > start_at),
  ADD CONSTRAINT booking_money_valid
    CHECK (price_minor_snapshot >= 0 AND discount_minor >= 0
           AND discount_minor <= price_minor_snapshot),
  ADD CONSTRAINT staff_booking_no_overlap
    EXCLUDE USING gist (
      tenant_id WITH =,
      staff_id WITH =,
      tstzrange(start_at, end_at, '[)') WITH &&
    ) WHERE (status IN ('confirmed', 'completed', 'no_show'));
```

Наше уточнение: завершённый раньше конца/отмеченный no_show визит не открывает остаток уже назначенного интервала для второго визита; cancelled освобождает интервал. Это соответствует расчёту загрузки, где completed/no_show занимают запланированные минуты. SQLSTATE `23P01` переводится в `409 SLOT_UNAVAILABLE`. Такие ограничения поддерживаются [PostgreSQL range/exclusion](https://www.postgresql.org/docs/17/rangetypes.html).

Обязательные индексы:

- bookings `(tenant_id,start_at,staff_id)`, `(user_id,start_at)`, `(tenant_id,customer_id,start_at)`, `(tenant_id,created_at)`, `(tenant_id,status,start_at)`;
- customers `(tenant_id,user_id)` partial unique, GIN trgm для нормализованных name/contact; tenant-фильтр всегда остаётся;
- staff_services `(tenant_id,service_id,staff_id)`;
- vouchers `(user_id,status,expires_at)`, `(campaign_id,issued_at)`, unique выдачи;
- notifications `(recipient_user_id,created_at DESC,id)`, фильтры tenant/kind;
- delivery/outbox/inbox partial индексы по pending-состояниям и `next_attempt_at/due_at`;
- audit `(tenant_id,occurred_at DESC,id)`; idempotency unique scope и TTL-индекс.

## 4. Единый способ выполнять команду

Контроллер: DTO → actor → scope → permission → idempotency → application use case. Use case: открыть transaction → заново проверить текущие права/версии/статусы → блокировки → правила → записи + аудит + outbox + idempotency result → commit. Ответ формируется только из разрешённой DTO-проекции.

Isolation P0 — READ COMMITTED с явными row locks и exclusion constraint. Для конкурентных операций это обязательная часть алгоритма, а не необязательная оптимизация. Deadlock/serialization failure (`40P01/40001`) — до трёх повторов **всей** транзакции с тем же operation ID, затем контролируемая временная ошибка. Никаких внешних вызовов внутри повторяемой транзакции.

Порядок блокировок унифицировать: tenant rows по UUID (FOR SHARE, статус меняется FOR UPDATE) → user rows по UUID, если проверяется общий календарь/согласия → membership → staff rows по UUID → booking rows по UUID → campaign rows по UUID → voucher rows по UUID. Переходы, затрагивающие несколько агрегатов, заранее собирают набор ссылок, затем после locks перечитывают их. Если набор изменился, транзакция перезапускается. Изменение каталога блокирует соответствующую услугу; графика — staff row. Ни одна операция не должна поздно захватывать ресурс из более ранней группы.

Полный реестр locks каждой команды фиксируется в коде use case и проверяется конкурентными тестами. Для купонной коррекции, затрагивающей A/B, заранее определить обе tenant и связанные bookings. Ограниченные повторные попытки нужны и при соблюдении порядка: транзакции БД могут конфликтовать по unique/index locks.

### 4.1. Идемпотентность без «потерянного pending»

1. Проверить личность, scope, право, формат. Нормализовать body (значения времени в UTC, неизменный порядок ключей), включить expectedVersion и тип операции в hash.
2. Короткой отдельной транзакцией создать `pending`-операцию с UUID, lease и fence. UNIQUE не даёт двум запросам создать одну операцию. Конкурентный duplicate читает существующий committed pending и получает 202 с operationId.
3. Исполнитель открывает бизнес-транзакцию и блокирует строку операции `FOR UPDATE NOWAIT`. Проверяет hash, state и fence. Только затем меняет бизнес-объекты.
4. В **той же** бизнес-транзакции сохраняет результат и `succeeded/rejected`. Бизнес-изменение без результата операции закоммитить нельзя.
5. При падении до commit бизнес-изменения откатываются, pending остаётся. Reconciler после lease (например 60 секунд) пытается взять row lock NOWAIT: живую транзакцию не отнимает; свободную просроченную операцию разрешает повторить/восстановить, увеличив fence. Сохранённого нормализованного намерения достаточно для безопасного восстановления; текущие права/правила проверяются снова.
6. Стабильные 4xx результаты храним; transient 5xx не превращаем в окончательный бизнес-отказ. Параллельный запрос не запускает вторую бизнес-транзакцию.

Результат и request_json завершённой операции хранятся 24 часа, fingerprint+result refs — 30 дней с ограничениями хранения аккаунта. Минимизировать request_json: для заметки использовать защищённую ссылку/минимальное намерение, не размножать открытый текст по логам. Pending с исчерпанным сроком восстановления переводится в технически отклонённый результат под lock, не выполняется спустя 24 часа. После 24 часов `409 IDEMPOTENCY_RESULT_EXPIRED`, а не повтор действия. Повтор того же ключа с другим телом — `409 IDEMPOTENCY_KEY_REUSED`; pending — `202 OPERATION_PENDING`; старый expectedVersion — `409 STALE_VERSION`. Перед возвратом сохранённого результата проверяем текущий доступ и разрешённые поля: понижение роли не открывает старый owner-response мастеру.

### 4.2. Расчёт слотов

Вход: tenant, service, дата/диапазон не более 30 дней, optional staff. Проверить published tenant, активную услугу и назначенных активных мастеров. Для каждого мастера:

1. Развернуть недельные интервалы на локальную дату; применить closed/replace-исключение.
2. Вычесть перерывы, получить непересекающиеся доступные интервалы.
3. Перевести в UTC с IANA zone. Несуществующее локальное время при переходе часов отклонять; неоднозначное время представлять двумя разными слотами с offset, а не угадывать. Создаваемые владельцем неоднозначные границы графика требуют явного offset/исправления.
4. Начала слотов выровнять по местным четвертям часа (00/15/30/45). Начало ≥ текущего времени; end = start + duration.
5. Весь `[start,end)` должен помещаться в доступный интервал. Вычесть блокирующие bookings.
6. Вернуть конкретные staffId/start/end, timezone, serviceVersion/scheduleVersion и цену. Для «Любой» выбрать детерминированно по имени/id и обязательно показать мастера до подтверждения.

Результат GET slots — подсказка, не lock. Короткого удержания слота в P0 не делаем. При подтверждении повторяем расчёт под staff row lock; изменение графика берёт тот же lock.

График сохраняет предыдущие версии. Будущие даты пересчитываются, закрытые прошлые даты snapshot не перезаписываются. Ежедневный worker материализует горизонт 30 дней и фиксирует завершившиеся локальные дни. При настройке сегодняшнего дня не разрешать менять уже прошедшие интервалы; будущие изменения того же дня журналируются. Для старой статистики используются сохранённые опубликованные интервалы по датам. Пустой/неизвестный исторический denominator не выдавать за нулевую загрузку: показывать «нет данных».

При конфликте новой версии графика с confirmed-визитами вернуть их разрешённый список и запросить подтверждение изменения графика с предупреждением. После подтверждения визиты остаются, сотрудник решает их отдельно; слот-генератор продолжает учитывать их занятость.

### 4.3. Создание записи и предупреждение клиенту

Сначала UI получает `booking quote`: серверная цена, длительность, мастер, скидка, правило отмены. Quote привязан к actor, tenant, customer, данным выбора и версиям; TTL 5 минут. Изменился каталог или условия — новый quote и явное подтверждение. Поля цены клиент не рассчитывает самостоятельно.

Транзакция CreateBooking:

1. Проверить/заблокировать scope, tenant published, роль. Для клиента userId только из session; customer найти/создать в этом tenant. Ручной customer допускает userId=null.
2. Проверить актуальность quote, master/service association, версии и время. Заблокировать мастера; для связанного пользователя сериализовать проверку общего календаря через user row lock.
3. Найти пересечения confirmed-записей связанного user в других tenant. Для клиента вернуть собственные детали; сотруднику — только факт пересечения без tenant, услуги и других чужих сведений.
4. Если есть пересечение и нет действительного warning challenge — `409 CLIENT_OVERLAP_CONFIRMATION_REQUIRED`; ничего не бронировать. Challenge связан с hash намерения, actor, quote, версией записи и fingerprint пересечений; TTL 5 минут.
5. Пользователь нажимает «Продолжить»: новый Idempotency-Key и тело с challenge. Повторно проверить fingerprint и все версии. При новых пересечениях/другом выборе выдать новое предупреждение. Для ручной записи сотрудник подтверждает «Предупреждение согласовано с клиентом»; факт и actor журналируются. Это наше уточнение UX, чужая история сотруднику не раскрывается.
6. Если указан voucher — lock voucher, проверить user, tenant B, service и срок `now < expiresAt`, `issuedAt ≤ startAt < expiresAt`, status issued, discount ≤ price. Установить reserved и связать запись.
7. INSERT booking confirmed. Exclusion constraint остаётся последней защитой занятости мастера. Записать revision, аудит, in-app events и будущие delivery rows; при условном шаге 6 финальная связка делается внутри этой же транзакции.
8. Зафиксировать результат идемпотентности и commit. Redis/MAX не участвуют в транзакции.

Две записи одного user, создаваемые параллельно в разных салонах, благодаря user lock не обходят предупреждение незаметно. Мастер busy → всегда отказ, даже с challenge. При конфликте выдаём ближайшие варианты отдельным чтением после rollback.

### 4.4. Перенос и отмена

Перенос использует тот же bookingId и expectedVersion. Разрешён только confirmed до startAt. Рабочая роль — owner/admin; клиент — только собственная запись. paused tenant разрешает сопровождение существующей записи.

Заблокировать старого и нового мастера по UUID, booking, применённый voucher. Проверить новый quote/интервал/предупреждение. При сохранении услуги сохраняются исходные price/duration snapshots, даже если каталог изменился; при смене услуги берутся текущие условия с явным подтверждением. Архивную услугу/мастера не назначаем заново. Если исходная услуга архивна, для переноса нужно выбрать действующую услугу либо сопровождать исходный визит без переноса.

При несовместимом купоне сервер отдаёт `409 VOUCHER_REMOVAL_CONFIRMATION_REQUIRED` и quote новой суммы. Только запрос с подтверждённым quote и `removeVoucher=true` снимает скидку. Запрещено автоматически обнулить discount. UPDATE booking и снятие/сохранение резерва — одна транзакция. Новое место занято → rollback, старое остаётся.

Любое изменение start/service/staff повышает version, создаёт revision, подавляет pending старые напоминания и планирует новые. Отмена: confirmed → cancelled, клиент до начала; owner/admin с причиной. Мастер отменять не может. Освободить резерв issued или expired по текущему времени, отменить ожидающие напоминания, сохранить историю и событие.

### 4.5. Завершение, неявка, исправление

`CompleteBooking`: confirmed и now ≥ startAt; owner/admin либо назначенный мастер. В одной транзакции: completed + version + outcome → reserved входящий voucher в redeemed → выдача положенных исходящих vouchers → аудит/уведомления. Мастер не выбирает скидку: используется уже привязанный купон. При нескольких подходящих кампаниях блокировать их в стабильном порядке.

Выдача происходит **в этой транзакции**, а не поздним обработчиком события. Так согласие, данное после визита, не создаёт купон задним числом, а отложенная обработка не попадает в другую версию кампании. При сбое выдачи весь completion откатывается; бизнес-критическая операция не должна зависеть от Redis или MAX.

`MarkNoShow`: аналогичные права и время; освободить резерв в issued/expired, исходящие купоны не выдавать. Из cancelled возврата нет.

`CorrectOutcome` отдельной командой только owner, обязательная причина, expectedVersion и idempotency. Не изменять время исторического визита:

| Исправление | Условие и эффект |
|---|---|
| completed → no_show | Свободные исходящие vouchers отозвать; reserved/redeemed последствия — создать исключения. Входящий redeemed не восстанавливать |
| no_show → completed | Не выпускать новые/повторные исходящие купоны. Если прежний входящий купон ушёл в другой визит или стал терминальным, вернуть `PARTNER_REVIEW_REQUIRED`. Если он всё ещё issued и доступен, owner может явно подтвердить восстановление прежней скидки: под voucher lock проверить исторический допустимый start и текущий срок, атомарно зарезервировать/использовать тот же купон. Без входящего купона исправить исход без скидки |
| completed/no_show → cancelled | Только если нет reserved/redeemed исходящих купонов-следствий; свободные отозвать. Входящий redeemed не разиспользовать |

Исключение видно владельцам участвующих салонов в безопасной проекции; не повышает цену записи B автоматически. В P0 экран позволяет зафиксировать причину и результат разбора/отменить запрос, но не предоставляет скрытую возможность выдать новую компенсационную скидку. Непредусмотренное экономическое действие запрещено, пока правило не согласовано отдельно.

## 5. Партнёрские кампании и купоны

### 5.1. Согласование версии

Кампания A→B односторонняя, инициатором может быть любая сторона. A и B должны быть разными опубликованными tenant с включённым партнёрством. Выбирать услуги B можно из публичного каталога, управлять им нельзя.

`CreateDraft` сохраняет редактируемую версию. `Propose` фиксирует неизменный terms_hash, согласие инициатора и pending version; второму владельцу создаёт событие. `Accept` под campaign lock проверяет expectedVersion/terms_hash/сторону/роль и фиксирует второе согласие. Нельзя принять «кампанию вообще» без конкретной версии.

Одна активная версия и не более одной текущей предлагаемой версии. Замена proposed создаёт новый draft и завершает старое предложение. Новая версия уже активной кампании согласуется, пока старая выдаёт купоны. Активация новой атомарно переключает active_version_id; issued_total общий. Новый лимит ≥ уже выданного. Все выданные купоны сохраняют собственный snapshot.

Pause хранится отдельно для каждой стороны. Удаление только своей паузы; active эффективен, когда ни одной паузы не осталось, срок подходит и оба tenant published. Пауза салона не переписывает вручную state каждой кампании: проверяем её как внешний запрет выдачи. Досрочный ended необратим; истечение выдачи закрывает кампанию, но не отнимает действующие купоны.

### 5.2. Выдача

Условие: исходный визит впервые переходит confirmed→completed, source service разрешена, оба бизнеса допускают партнёрство и опубликованы, обе стороны приняли active version, нет campaign pauses, время завершения в `[issue_from,issue_until)`, клиент связан с MAX и имеет global consent И `partner_allowed[A]`.

Если хотя бы одно условие не выполнено — completion всё равно допускается, купон не выдаётся; причина «не подходит» не является технической ошибкой. Отсутствие связи с MAX не ставит отложенную выдачу на будущее.

Под campaign row lock проверить issued_total < issue_limit и unique выдачи; вставить voucher, увеличить issued_total ровно один раз. Для срока берём `issuedAt + voucher_valid_days × 24 часа`; UI показывает точный момент истечения и зону. Это выбранная однозначная трактовка срока P0. Дата конца выдачи кампании не сокращает срок уже выданного купона.

Лимит lifetime на campaignId, включая expired/revoked/redeemed. Отмена, expiry, отзыв и смена версии не уменьшают issued_total. Уникальность не заменяется одной лишь дедупликацией worker.

### 5.3. Резерв, истечение и отзыв

issued→reserved — только вместе с booking B. reserved→redeemed — только с completed того же booking. Не делать публичный endpoint «погасить по voucherId» вне визита. Администратор ручного визита выбирает только купон связанного MAX user своей карточки.

expired/revoked/redeemed терминальны. Expiry worker переводит только issued. reserved остаётся до исхода допустимого визита, даже если staff отметил completion позднее expiry. При переносе ранее зарезервированного визита новое start должно снова попадать в срок; завершать прежнее обязательство после expiry можно, создавать новое резервирование нельзя.

Экстренный отзыв issued: владелец участвующей стороны с причиной → revoked и уведомление. reserved: сначала `revocation_request`; клиент видит новую цену и подтверждает, затем единая транзакция booking version/discount + voucher revoked. Если клиент отказал/молчит, скидка остаётся; владелец может отдельно отменить запись по разрешённым правилам, но не выдать молчание за согласие. Для redeemed возвращаем недопустимый переход, доступен только журнал исключения.

## 6. Tenant, приглашения и ручные карточки

Публикация tenant проверяет профиль, способ связи, хотя бы одну активную услугу с мастером и доступным интервалом. Черновик оформления может существовать параллельно опубликованной версии. Публикация оформления и operational status — разные операции: сохранение черновика не закрывает работающий салон.

published→paused блокирует новые bookings и новые выдачи кампаний с любой стороны. Отмена/перенос/исход существующих визитов разрешены по роли. Архивировать можно draft без обязательств или paused без confirmed-визитов, незавершённых issued/reserved обязательств и активных кампаний. Прямого published→archived нет. archived→paused — восстановление для настройки, затем отдельная публикация.

Сотрудник: owner создаёт invite на admin/master, срок 24 часа; для master можно сразу связать staff. Принятие требует авторизации, токена и явного действия. UNIQUE membership и lock invite предотвращают повтор. Если известен expected_user_id, принять может только он; иначе владелец осознанно передаёт bearer-ссылку адресату и видит принявшего. При существующей другой роли — 409, не молчаливое повышение. Восстановление revoked только новым приглашением. Последнего owner нельзя отозвать/понизить. При отзыве операционного получателя в той же транзакции выбираем владельца как fallback, не включая ему сообщения без согласия.

Ручной customer: user_id=null, имя/контакт вымышленные для демо, уведомлений MAX нет. Связывание не по телефону:

1. owner/admin создаёт одноразовую link-ссылку конкретной карточки и передаёт предполагаемому клиенту.
2. Авторизованный клиент видит салон и минимальную маску карточки; подтверждает принадлежность. До завершения привязки история/заметки не раскрываются.
3. Как дополнительная защита от пересланной ссылки, сотрудник подтверждает увиденный MAX-аккаунт в CRM.
4. В транзакции блокируем invite/customer/user, проверяем отсутствие чужой связи и другого customer этого user в tenant. Конфликт — `CUSTOMER_LINK_CONFLICT`, без авто-слияния.
5. Заполняем customer.user_id и связанные booking.user_id, сохраняем аудит. Теперь клиент видит собственную историю; будущие новые события доставляются по настройкам. Старые сообщения/купоны не выдаются задним числом.

Два подтверждения — наше техническое решение безопасной привязки. Без них нельзя считать человека владельцем ручной истории только по обладанию пересланной ссылкой.

## 7. События, уведомления и восстановление

### 7.1. Формат события

```json
{
  "eventId": "uuid",
  "type": "booking.rescheduled",
  "schemaVersion": 1,
  "aggregateId": "uuid",
  "aggregateVersion": 4,
  "tenantId": "uuid",
  "occurredAt": "2026-09-19T09:00:00Z",
  "actorUserId": "uuid",
  "correlationId": "uuid",
  "data": {"bookingId": "uuid", "oldStaffId": "uuid", "newStaffId": "uuid"}
}
```

События: tenant.published/paused/archived; booking.created/rescheduled/cancelled/completed/no_show/outcome_corrected; membership.invited/accepted/revoked; customer.linked; campaign.proposed/accepted/rejected/paused/resumed/ended/version_activated; voucher.issued/reserved/released/redeemed/expired/revoked; consent.changed; bot.channel_changed. Каталог/график/заметки/изображения обязательно пишут аудит, но не все требуют пользовательского уведомления.

События содержат ссылки и минимальные служебные поля, без внутренних заметок/контактов. API считает статистику из текущих bookings/vouchers/snapshots, а не суммирует все события `completed`: исправление иначе удвоит показатели.

In-app notifications и due-deliveries основных команд создаются в той же транзакции из общего notification planner. Outbox сообщает worker о новых delivery IDs, не создаёт вторую копию уведомления. Все получатели дедуплицируются по user+event: если owner одновременно мастер, одно безопасное сообщение вместо двух.

### 7.2. Доставка через outbox

1. Команда commit-ит событие, in-app ленту и delivery scheduled. Ответ пользователю не ждёт Redis.
2. Outbox dispatcher берёт batch через `FOR UPDATE SKIP LOCKED` с lease, добавляет BullMQ job `delivery-<uuid>` и отмечает публикацию. Добавление в Redis и отметка PostgreSQL не атомарны: повтор безопасен по стабильному jobId и проверке delivery state.
3. Worker CAS-переходом и lease берёт delivery. Проверяет актуальные права, согласия, channel generation, booking/version/status, due/not_after. Устаревшее — suppressed.
4. Получает распределённое разрешение rate limiter; если ждать — возвращает job в отложенное исполнение, не держит DB transaction и не занимает очередь длительным sleep.
5. Непосредственно перед HTTP повторно проверяет актуальность. Сохраняет attempt, выполняет MAX API вне БД, затем sent/retry_wait/failed.
6. Reconciler каждые 15 секунд ищет due scheduled/retry_wait и потерянные/просроченные leases; восстанавливает очередь из PostgreSQL. Поэтому потеря Redis не теряет обязательства.

Redis: AOF `appendfsync everysec`, `maxmemory-policy noeviction`, внутренний порт, volume. AOF уменьшает потери, но не даёт абсолютной гарантии сохранения каждого job; восстановление из БД обязательно. [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

BullMQ используется для исполнения; состояние attempts и next_attempt_at канонично в PostgreSQL. Не включать параллельно два независимых retry-цикла (автоматический transport + queue + БД). Queue retry разрешён для инфраструктурного падения processor, после которого он снова читает delivery. [Механизм BullMQ retry](https://docs.bullmq.io/guide/retrying-failing-jobs).

### 7.3. Актуальность и повторы

Напоминания для версии записи: ключ `(bookingId,version,24h|2h,recipient)`, due=start−24h/2h. Если due уже прошёл при создании/переносе, такое напоминание не планируется. Задержка исполнения >15 минут после due — проектный предел, напоминание suppressed. Отмена или другая version также suppressed. Цель постановки обычного нового события в очередь ≤30 секунд, а не гарантия доставки внешней платформой.

Подтверждение/перенос имеет not_after=min(startAt, createdAt+24h); отмена — createdAt+24h; предложение — min(expiresAt,createdAt+24h). Это проектные пределы актуальности доставки; история в приложении остаётся. Для серии изменений отправляем актуальное состояние, старые superseded сообщения подавляем.

Retry: до 6 попыток с базовыми интервалами 5s/30s/2m/10m/30m и jitter ±20%; всегда учитывать not_after. При 429 использовать Retry-After, если есть, и общий cooldown; без заголовка — backoff. Постоянная ошибка получателя прекращает конкретную доставку; ошибку токена/SSL отмечать как сбой интеграции, не как остановку каждого пользователя. Timeout после отправки — outcome unknown: можно повторить, возможен дубль внешнего сообщения. Внутреннее событие и запись при этом не дублируются.

Остановка/удаление канала в одной транзакции увеличивает generation и подавляет scheduled/retry_wait. Возобновление создаёт новую generation: старые задания не оживают. Принятый MAX запрос уже нельзя отозвать этой проверкой; гонка после последней проверки/in-flight сообщения документируется честно. Аналогично нельзя отменить физически уже отправленный HTTP в момент переноса. На текущем экране всегда читать актуальный booking, а не доверять старому тексту сообщения.

### 7.4. Распределённые лимиты

Одного limiter BullMQ недостаточно для двух уровней и служебных HTTP-вызовов. Реализовать в `max-api/rate-limit.ts` атомарный Redis Lua sliding window: ключи global(bot) и dialog(bot,user), отсечь timestamps старше 1000ms, проверить оба бюджета, зарезервировать текущую попытку только если оба допускают; время из Redis TIME, уникальный attemptId. Иначе вернуть waitMs. Для сообщений проектно 25 rps global и 1 rps dialog; глобальный потолок конфигурации 30, dialog 2.

Все workers и ops MAX client используют один namespace бота. При Redis unavailable отправки останавливаются, данные остаются в PostgreSQL. После перезапуска Redis выдержать 1 секунду до новых разрешений. Тест: минимум два worker, несколько диалогов, sliding window ни разу не выше потолков. Не использовать устаревший BullMQ `groupKey`: его удаление описано в [официальном limiter guide](https://docs.bullmq.io/guide/rate-limiting).

### 7.5. Inbox и порядок внешних событий

Не предполагать общий `update_id`: подтверждённого единого такого поля в просмотренном контракте нет. Event key: type + стабильный message/callback id, когда он есть; иначе SHA-256 канонического внешнего события с timestamp/user/chat/type. Поле JSON нормализовать по порядку ключей, не менять значения. Храним payload ограниченно, секрет заголовка никогда.

Для channel-events под user/channel lock применяем только событие новее `last_event_at_ms`, при одинаковом timestamp приоритет removed > stopped > active. Повтор не увеличивает generation. Это проектная политика разрешения равного timestamp, её проверить на реальных fixture. Запоздалый started не возобновляет более поздний stop. Inbox consumer и его отметка processed коммитятся вместе; при падении повтор не меняет состояние второй раз.

## 8. Метрики без двусмысленности

Все периоды задаются локальными датами салона; сервер преобразует `[startOfDay(from),startOfDay(to+1))` в UTC. Для визитов фильтр по startAt, для created bookings отдельно по createdAt. Фильтр мастера применяется последовательно к числителю/знаменателю; cohort first-completed вычисляется по всему салону до фильтра мастера.

| Метрика | SQL-смысл |
|---|---|
| created | COUNT уникальных bookings по created_at в периоде |
| planned/completed/cancelled/no_show | COUNT по текущему status и start_at в периоде |
| no-show rate | no_show / (completed+no_show), нулевой denominator → null |
| cancellation rate | cancelled / все четыре status по start_at |
| service value | SUM(price_snapshot−discount) для текущих completed; это стоимость, не выручка |
| average visit | service value / completed |
| new customers | DISTINCT customer, чей MIN(completed.start_at) по всей истории tenant попадает в период |
| returning | DISTINCT customer с completed в периоде и более ранним completed до начала периода |
| utilization | Сумма минут пересечения `[start,end)` с периодом для confirmed/completed/no_show / доступные опубликованные минуты соответствующих staff |
| coupon conversion | redeemed из купонов, issued_at которых в когорте / все выданные в той же когорте |

Загрузку не обрезать до 100%: если сохранённые записи выходят за сокращённый рабочий график, показать факт и пояснение. Denominator=0 → «—». Пример проверки: 8 часов работы − 1 час перерыва =420 минут; визиты 60+30, отменённый 45 не входит; загрузка 90/420=21,43%.

Пример cohort: выдано в сентябре 10, из них к 10 октября использовано 4 →40%, даже если в октябре использовано ещё 7 августовских купонов. Показывать дату расчёта и остаток issued/reserved. B получает только собственные bookings, A — агрегаты без списка клиентов B.

В P0 считаем запросами PostgreSQL с индексами, без materialized views и Redis-кеша аналитики. Query refetch каждые 5 секунд на открытом экране + invalidation после собственной команды обеспечивает цель обновления ≤10 секунд при здоровом сервере. При росте добавим агрегаты после замера, сохранив формулы и возможность сверки.
