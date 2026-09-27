# Независимое ревью ТЗ «Живое окно Lite»

Дата: 27 сентября 2026 года  
Исходная версия: 0.1 `DRAFT`  
Результат: версия 0.2 `SPEC_READY`

## Метод

Документ независимо проверили три рецензента без права редактировать общие файлы:

1. продукт/UX и операционный процесс салона;
2. доменная модель, PostgreSQL, конкурентность, idempotency и worker;
3. security, MAX, уведомления, QA и эксплуатация.

Основной агент сопоставил замечания с текущими booking/scheduling/worker механизмами проекта и внёс согласованные решения в спецификацию. Ниже сохранён disposition существенных замечаний.

## Замечания и решения

| Область | Severity | Замечание | Решение в v0.2 |
|---|---:|---|---|
| Обещание клиенту | Blocker | Countdown выглядел как эксклюзивный резерв, хотя hold отсутствует | Offer переименован в возможность попытки записи; в MAX/UI обязательный текст, что слот доступен другим |
| CTA | High | Вход только при полностью пустом результате слишком узок | Основной CTA при пустом фильтре и постоянная вторичная ссылка при наличии неудобных слотов |
| Trigger | High | «Появится время» обещало больше, чем cancellation/reschedule | Lite явно реагирует только на отмену и обычный перенос |
| Approval | High | Approval каждого окна убирал скорость и автоматизацию | Автоматический dispatch после явного owner opt-in; предупреждение сотруднику, pause и kill switch |
| PATCH request | Blocker | Старый offer одновременно сохранялся и отзывался | Любое match-изменение атомарно revoke offer; offer хранит request version/fingerprint |
| Антиспам | Blocker | Не было числовых ограничений | 3 active request/tenant, 3 offer/request/24h, 1 offer/user/30min, 1 active offer/user |
| FIFO | High | `created_at` позволял удерживать очередь после расширения условий | Введён `priority_at`; расширение сбрасывает, сужение и pause/resume сохраняют |
| Bot unavailable | Blocker | Request выглядел active, хотя доставить offer нельзя | `paused_channel_unavailable`, видимая причина, revalidation после `bot_started`; in-app не push-fallback |
| TTL | Blocker | Не было определено начало отсчёта | TTL начинается по DB time после успешного принятия MAX API; pending delivery имеет отдельное состояние |
| Linked booking | Blocker | Не определены ownership/version/snapshots/price/voucher | Только own future confirmed booking; обычный reschedule flow и version check; target strictly earlier |
| Cascade | Critical | Linked reschedule конфликтовал с общим release event | Causation + `cascade=false` для live-window accept; обычный перенос сохраняет `cascade=true` |
| Offer chain | Critical | Decline мог повторно выбрать того же FIFO-кандидата | `offering→matching`, unique window/request и sequence, prior candidates исключаются |
| Duration | Critical | Матч проверял окно, а не визит; linked duration конфликтовала с каталогом | Fixed start; actual duration для новой записи, snapshot для linked; `visit_end<=window.end`, без repacking |
| Domain outbox | High | Существующий delivery outbox не является event bus | Отдельный additive `domain_outbox` с event key, old slot snapshot, lease/fence/recovery |
| Lock protocol | High | Абстрактный staff lock не защищал ordinary booking | Существующий global advisory gate + фиксированный row-lock order + GiST как финальная защита |
| Worker races | High | Не был задан claim нескольких worker/window | SKIP LOCKED/lease/fence, partial unique constraints, recheck под gate |
| DB tenant integrity | Blocker | Ссылки могли теоретически соединить разные tenant | Composite tenant FK/equivalent invariant на всех relation и tenant-qualified lookup |
| Deep link trust | Blocker | Offer ID мог ошибочно трактоваться как credential | Deep link только navigation; MAX init/session и ownership повторно проверяются |
| RBAC | Blocker | «Сотрудник в разрешённом объёме» не задавал права | Owner config; owner/admin operational pause/close/read; master без очереди; `/me` только session user |
| Retry/suppression | High | Не было terminal/permanent/backoff/dedupe правил | Dedupe key, bounded retry/jitter/Retry-After, permanent terminal, suppression перед transport, safe stale link |
| Pause/off | High | Неясна судьба active offer и delivery | Active offer revoked, pending suppressed, request paused; resume не оживляет старые offer |
| Consent/privacy | High | Не было version/timestamp/retention и lock-screen minimization | Consent lifecycle fields, минимальные сообщения, redaction и retention/aggregation requirements |
| Quiet hours | Medium | Возможны ночные срочные сообщения | Tenant-local quiet hours default 09:00–21:00 и совместная проверка minimum notice |
| Admin queue | Medium | Экран мог позволить обход FIFO вручную | Только агрегаты и аудит прошлых переходов; reorder/priority override запрещён |
| Slot appeared before request | High | Между поиском и submit мог появиться обычный слот | Create повторно проверяет доступность и предлагает обычную запись вместо молчаливой очереди |
| Observability | Medium | Не хватало outbox age, expiry lag, DLQ и stuck-chain сигналов | Добавлены ops metrics и runbook requirements |
| Acceptance oracle | High | Несколько AC допускали два результата либо были слишком общими | AC10/20/24/29/30 уточнены, добавлены LW-AC31–LW-AC46 |

## Принятые компромиссы Lite

- Нет hold до accept: это уменьшает блокировку органических записей, но требует честного UX и метрики проигранных гонок.
- Только та же услуга, что у отменённой записи: безопаснее для первого релиза; окна, потерянные из-за этого ограничения, измеряются.
- Нет каскада от старого времени linked reschedule: ограничивает сложность и риск бесконечных цепочек.
- MAX bot является обязательным своевременным каналом предложения; центр событий пока только история.
- Администратор не меняет FIFO и не получает контакты будущих кандидатов.

## Итоговая проверка готовности

- Продуктовый сценарий и границы Lite определены.
- Спорные решения раздела 21 закрыты.
- State machines имеют пути продолжения и конечные состояния.
- Domain event durability отделена от внешней доставки.
- Конкурентность, idempotency, lock order и DB-инварианты заданы.
- RBAC, tenant isolation, MAX trust boundary, consent и suppression заданы.
- Acceptance criteria имеют однозначный наблюдаемый результат.

Вердикт: **SPEC_READY**. Реализация может начинаться только по версии 0.2 и должна пройти LW-AC01–LW-AC46.
