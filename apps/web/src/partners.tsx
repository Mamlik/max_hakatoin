import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, useApi } from "./api";
import {
  PageTitle,
  Field,
  Check,
  Load,
  Empty,
  Badge,
  money,
  dateTime,
  dayISO,
  useAction,
  Modal,
  SimpleForm,
  CommandButton,
} from "./ui";
import type {
  Salon,
  Items,
  Campaign,
  CampaignVersion,
  Catalog,
  Voucher,
} from "./types";
const rewardLabel=(v:{rewardType?:string;discountMinor:number|null;discountPercent?:number|null;freeVisitsCount?:number|null})=>v.rewardType==='percent'?`${v.discountPercent}%`:v.rewardType==='free_visits'?`${v.freeVisitsCount} бесплатн. посещ.`:money(v.discountMinor);

function CampaignForm({
  tenant,
  salons,
  campaign,
  edit,
  onDone,
}: {
  tenant: Salon;
  salons: Salon[];
  campaign?: Campaign;
  edit?: CampaignVersion;
  onDone: () => void;
}) {
  const t = tenant.id;
  const [partner, setPartner] = useState(
      campaign
        ? campaign.sourceTenantId === t
          ? campaign.targetTenantId
          : campaign.sourceTenantId
        : "",
    ),
    [direction, setDirection] = useState(
      campaign?.targetTenantId === t ? "incoming" : "outgoing",
    );
  const source =
      direction === "outgoing" ? tenant : salons.find((s) => s.id === partner),
    target =
      direction === "outgoing" ? salons.find((s) => s.id === partner) : tenant;
  const src = useApi<Catalog>(
      source ? `/public/salons/${source.publicCode}/catalog` : null,
    ),
    dst = useApi<Catalog>(
      target ? `/public/salons/${target.publicCode}/catalog` : null,
    );
  const [sourceIds, setSourceIds] = useState(
      edit?.sourceServiceIds ?? campaign?.versions[0]?.sourceServiceIds ?? [],
    ),
    [targetIds, setTargetIds] = useState(
      edit?.targetServiceIds ?? campaign?.versions[0]?.targetServiceIds ?? [],
    );
  const base = edit ?? campaign?.versions[0];
  const [rewardType,setRewardType]=useState<'fixed'|'percent'|'free_visits'>(base?.rewardType??'fixed');
  return (
    <>
      <div className="notice">
        Источник A выдаёт купон после завершённого визита. Принимающий B
        предоставляет согласованную награду. Оба владельца согласуют одну и ту же
        версию.
      </div>
      {!campaign && (
        <>
          <Field label="Направление">
            <select
              value={direction}
              onChange={(e) => {
                setDirection(e.target.value);
                setSourceIds([]);
                setTargetIds([]);
              }}
            >
              <option value="outgoing">Мой салон A → партнёр B</option>
              <option value="incoming">Партнёр A → мой салон B</option>
            </select>
          </Field>
          <Field label="Салон-партнёр">
            <select
              value={partner}
              onChange={(e) => {
                setPartner(e.target.value);
                setSourceIds([]);
                setTargetIds([]);
              }}
            >
              <option value="">Выберите салон</option>
              {salons
                .filter((s) => s.id !== t && s.partnerEnabled)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </Field>
          {!salons.filter((s) => s.id !== t && s.partnerEnabled).length && (
            <p className="small muted">
              Пока нет салонов, готовых к партнёрству. Второй владелец должен
              включить участие в своём кабинете — после этого салон появится в
              списке.
            </p>
          )}
        </>
      )}
      {source && target && (
        <>
          <div className="two-columns">
            <div>
              <h3>Визит в A · {source.name}</h3>
              {src.data?.services.map((s) => (
                <Check
                  key={s.id}
                  label={s.name}
                  checked={sourceIds.includes(s.id)}
                  onChange={(yes) =>
                    setSourceIds(
                      yes
                        ? [...sourceIds, s.id]
                        : sourceIds.filter((id) => id !== s.id),
                    )
                  }
                />
              ))}
            </div>
            <div>
              <h3>Скидка в B · {target.name}</h3>
              {dst.data?.services.map((s) => (
                <Check
                  key={s.id}
                  label={`${s.name} · ${money(s.priceMinor)}`}
                  checked={targetIds.includes(s.id)}
                  onChange={(yes) =>
                    setTargetIds(
                      yes
                        ? [...targetIds, s.id]
                        : targetIds.filter((id) => id !== s.id),
                    )
                  }
                />
              ))}
            </div>
          </div>
          <SimpleForm
            fields={[
              {
                name: "rewardAmount",
                label: rewardType==='fixed'?"Скидка, ₽":rewardType==='percent'?"Скидка, %":"Бесплатных посещений",
                type: "number",
              },
              {
                name: "issueFrom",
                label: "Начало выдачи (московское время)",
                type: "datetime-local",
                required:false,
              },
              {
                name: "issueUntil",
                label: "Окончание выдачи (московское время)",
                type: "datetime-local",
                required:false,
              },
              {
                name: "voucherValidDays",
                label: "Срок купона, суток по 24 часа",
                type: "number",
                required:false,
              },
              {
                name: "issueLimit",
                label: "Общий лимит выдачи за всю кампанию",
                type: "number",
                required:false,
              },
              {
                name: "termsText",
                label: "Условия для клиента",
                type: "textarea",
              },
            ]}
            initial={{
              rewardAmount:base?rewardType==='fixed'?(base.discountMinor??0)/100:rewardType==='percent'?base.discountPercent??10:base.freeVisitsCount??1:300,
              issueFrom: base?.issueFrom?toMoscowInput(base.issueFrom):'',
              issueUntil: base
                && base.issueUntil ? toMoscowInput(base.issueUntil)
                : `${dayISO(30)}T23:59`,
              voucherValidDays: base?.voucherValidDays ?? 14,
              issueLimit: base?.issueLimit ?? 100,
              termsText:
                base?.termsText ??
                "Персональная скидка на выбранные услуги. Один купон на визит.",
            }}
            submit={edit ? "Сохранить черновик" : "Создать черновик версии"}
            children={<Field label="Тип награды"><select name="rewardType" value={rewardType} onChange={e=>setRewardType(e.target.value as typeof rewardType)}><option value="fixed">Скидка в рублях</option><option value="percent">Процент</option><option value="free_visits">Бесплатные посещения</option></select></Field>}
            onSubmit={async (v) => {
              const terms = {
                sourceServiceIds: sourceIds,
                targetServiceIds: targetIds,
                rewardType,
                discountMinor:rewardType==='fixed'?Math.round(Number(v.rewardAmount)*100):null,
                discountPercent:rewardType==='percent'?Number(v.rewardAmount):null,
                freeVisitsCount:rewardType==='free_visits'?Number(v.rewardAmount):null,
                issueFrom: v.issueFrom?new Date(`${v.issueFrom}:00+03:00`).toISOString():null,
                issueUntil: v.issueUntil?new Date(`${v.issueUntil}:00+03:00`).toISOString():null,
                voucherValidDays:v.voucherValidDays?Number(v.voucherValidDays):null,
                issueLimit:v.issueLimit?Number(v.issueLimit):null,
                termsText: v.termsText,
              };
              await api(
                `/work/${t}/campaigns${campaign ? `/${campaign.id}/versions${edit ? `/${edit.id}` : ""}` : ""}`,
                edit ? "PATCH" : "POST",
                {
                  ...terms,
                  ...(campaign
                    ? { expectedVersion: edit?.version ?? campaign.version }
                    : { sourceTenantId: source.id, targetTenantId: target.id }),
                },
              );
              onDone();
            }}
          />
        </>
      )}
    </>
  );
}
function toMoscowInput(value: string) {
  return new Date(new Date(value).getTime() + 3 * 3600000)
    .toISOString()
    .slice(0, 16);
}
function CampaignStats({
  tenantId,
  campaignId,
}: {
  tenantId: string;
  campaignId: string;
}) {
  const data = useApi<{
    issued: number;
    redeemed: number;
    reserved: number;
    conversion: number | null;
  }>(`/work/${tenantId}/campaigns/${campaignId}/analytics`, true);
  return (
    <div className="campaign-stats">
      <span>
        Выдано в этом месяце: <strong>{data.data?.issued ?? "—"}</strong>
      </span>
      <span>
        Из них использовано: <strong>{data.data?.redeemed ?? "—"}</strong>
      </span>
      <span>
        Конверсия когорты:{" "}
        <strong>
          {data.data?.conversion == null
            ? "—"
            : `${Math.round(data.data.conversion * 100)}%`}
        </strong>
      </span>
    </div>
  );
}
export function PartnersPage() {
  const { t } = useParams();
  const profile = useApi<Salon>(`/work/${t}/profile`),
    salons = useApi<Items<Salon>>("/public/salons"),
    data = useApi<Items<Campaign>>(`/work/${t}/campaigns`, true),
    vouchers = useApi<Items<Voucher>>(`/work/${t}/vouchers`),
    exceptions = useApi<
      Items<{ id: string; status: string; reason: string; resolution: string }>
    >(`/work/${t}/partner-exceptions`);
  const a = useAction();
  const [form, setForm] = useState<{
      campaign?: Campaign;
      edit?: CampaignVersion;
    } | null>(null),
    [pause, setPause] = useState<Campaign>(),
    [revoke, setRevoke] = useState<Voucher>(),
    [exception, setException] = useState<string>(),
    [history, setHistory] = useState<Campaign>();
  return (
    <>
      <PageTitle
        eyebrow="СОСЕДСТВО, КОТОРОЕ ПРИНОСИТ ПОЛЬЗУ"
        title="Партнёрские программы"
        description="Приглашайте клиентов друг к другу на прозрачных, согласованных условиях."
        action={
          <button
            className="button primary"
            disabled={!profile.data?.partnerEnabled}
            onClick={() => setForm({})}
          >
            Создать кампанию
          </button>
        }
      />
      <section className="panel">
        <Check
          label="Салон участвует в партнёрских программах"
          checked={profile.data?.partnerEnabled ?? false}
          disabled={a.busy || !profile.data}
          onChange={(enabled) =>
            void a.run(() =>
              api(`/work/${t}/partner-settings`, "PATCH", {
                enabled,
                expectedVersion: profile.data!.version,
              }),
            )
          }
        />
        <p className="small muted">
          Отключение прекращает новые выдачи. Условия уже выданных купонов
          сохраняются. Партнёр также должен самостоятельно включить участие.
        </p>
        {a.feedback}
      </section>
      <Load {...data}>
        {data.data?.items.length ? (
          data.data.items.map((c) => (
            <section className="panel campaign-card" key={c.id}>
              <div className="section-head">
                <div>
                  <span className="eyebrow">ИСТОЧНИК A → ПРИНИМАЮЩИЙ B</span>
                  <h2>
                    {c.sourceName} → {c.targetName}
                  </h2>
                </div>
                <Badge status={c.status} />
              </div>
              <p>
                Выдано за всё время: <strong>{c.issuedTotal}</strong>
              </p>
              {c.pauses.map((p) => (
                <div className="notice" key={p.tenantId}>
                  Пауза стороны {p.tenantName}: {p.reason}
                </div>
              ))}
              <div className="version-list">
                {c.versions
                  .filter((v) =>
                    ["draft", "proposed", "active"].includes(v.status),
                  )
                  .map((v) => (
                    <div className="version-card" key={v.id}>
                      <div className="section-head">
                        <h3>
                          Версия {v.number} · награда {rewardLabel(v)}
                        </h3>
                        <Badge status={v.status} />
                      </div>
                      <p>{v.termsText}</p>
                      <dl>
                        <dt>Период выдачи</dt>
                        <dd>
                          {v.issueFrom?dateTime(v.issueFrom):'с публикации'} — {v.issueUntil?dateTime(v.issueUntil):'без срока'}
                        </dd>
                        <dt>Срок купона</dt>
                        <dd>{v.voucherValidDays} суток</dd>
                        <dt>Общий лимит</dt>
                        <dd>{v.issueLimit}</dd>
                        <dt>Услуги A / B</dt>
                        <dd>
                          {v.sourceServiceIds.length} /{" "}
                          {v.targetServiceIds.length}
                        </dd>
                        <dt>Согласования</dt>
                        <dd>{v.acceptances.length} из 2</dd>
                      </dl>
                      {v.number > 1 && (
                        <p className="small muted">
                          Новая версия применяется только к будущим выдачам
                          после второго согласия. Старые купоны сохраняют свой
                          снимок условий.
                        </p>
                      )}
                      <div className="inline-actions">
                        {v.status === "draft" && (
                          <>
                            <button
                              className="button secondary"
                              onClick={() => setForm({ campaign: c, edit: v })}
                            >
                              Редактировать
                            </button>
                            <CommandButton
                              path={`/work/${t}/campaigns/${c.id}/versions/${v.id}/propose`}
                              body={{ expectedVersion: c.version }}
                              label={`Предложить версию ${v.number}`}
                            />
                            <button
                              className="text-button danger-text"
                              disabled={a.busy}
                              onClick={() =>
                                void a.run(() =>
                                  api(
                                    `/work/${t}/campaigns/${c.id}/versions/${v.id}`,
                                    "DELETE",
                                    { expectedVersion: v.version },
                                  ),
                                )
                              }
                            >
                              Удалить черновик
                            </button>
                          </>
                        )}
                        {v.status === "proposed" &&
                          v.proposedByTenantId !== t && (
                            <>
                              <CommandButton
                                path={`/work/${t}/campaigns/${c.id}/versions/${v.id}/accept`}
                                body={{
                                  expectedVersion: c.version,
                                  termsHash: v.termsHash,
                                  explicitConfirmation: true,
                                }}
                                label={`Принимаю версию ${v.number}`}
                              />
                              <CommandButton
                                path={`/work/${t}/campaigns/${c.id}/versions/${v.id}/reject`}
                                body={{ expectedVersion: c.version }}
                                label="Отклонить"
                              />
                            </>
                          )}
                        {v.status === "proposed" &&
                          v.proposedByTenantId === t && (
                            <CommandButton
                              path={`/work/${t}/campaigns/${c.id}/versions/${v.id}/withdraw`}
                              body={{ expectedVersion: c.version }}
                              label="Отозвать предложение"
                            />
                          )}
                      </div>
                    </div>
                  ))}
              </div>
              <CampaignStats tenantId={t!} campaignId={c.id} />
              <div className="inline-actions">
                <button
                  className="button secondary"
                  onClick={() => setHistory(c)}
                >
                  История версий
                </button>
                {c.status !== "ended" && (
                  <>
                    {!c.pendingVersionId &&
                      !c.versions.some((v) => v.status === "draft") && (
                        <button
                          className="button secondary"
                          onClick={() => setForm({ campaign: c })}
                        >
                          Новая версия
                        </button>
                      )}
                    {c.pauses.some((p) => p.tenantId === t) ? (
                      <CommandButton
                        path={`/work/${t}/campaigns/${c.id}/resume`}
                        body={{ expectedVersion: c.version }}
                        label="Снять свою паузу"
                      />
                    ) : (
                      <button
                        className="button secondary"
                        onClick={() => setPause(c)}
                      >
                        Поставить на паузу
                      </button>
                    )}
                    <CommandButton
                      path={`/work/${t}/campaigns/${c.id}/end`}
                      body={{ expectedVersion: c.version }}
                      label="Завершить выдачу навсегда"
                      danger
                    />
                  </>
                )}
              </div>
            </section>
          ))
        ) : (
          <Empty
            title="Пока нет партнёрских программ"
            text="Включите участие у двух салонов, создайте условия и согласуйте их вторым владельцем."
          />
        )}
      </Load>
      <section className="panel">
        <h2>Купоны и обязательства</h2>
        {vouchers.data?.items.map((v) => (
          <div className="history-row" key={v.id}>
            <strong>{rewardLabel(v)}</strong>
            <Badge status={v.status} />
            <small>{v.expiresAt?`До ${dateTime(v.expiresAt)}`:'Без срока'}</small>
            {["issued", "reserved"].includes(v.status) && (
              <button className="text-button" onClick={() => setRevoke(v)}>
                {v.status === "reserved" || v.reservedVisits > 0
                  ? "Запросить снятие скидки"
                  : "Отозвать"}
              </button>
            )}
          </div>
        ))}
        {!vouchers.data?.items.length && (
          <p className="muted">Выданных купонов пока нет.</p>
        )}
        <p className="small muted">
          Зарезервированную скидку можно снять только после явного согласия
          клиента с новой ценой. Использованный купон не восстанавливается.
        </p>
      </section>
      <section className="panel">
        <h2>Партнёрские исключения</h2>
        {exceptions.data?.items.map((e) => (
          <div className="sub-panel" key={e.id}>
            <p>{e.reason}</p>
            <p>{e.resolution}</p>
            {e.status === "open" && (
              <button
                className="button secondary"
                onClick={() => setException(e.id)}
              >
                Зафиксировать разбор
              </button>
            )}
          </div>
        ))}
        {!exceptions.data?.items.length && (
          <p className="muted">Открытых исключений нет.</p>
        )}
      </section>
      {form && profile.data && (
        <Modal
          title={
            form.edit
              ? "Редактирование черновика"
              : "Условия партнёрской программы"
          }
          onClose={() => setForm(null)}
        >
          <CampaignForm
            tenant={profile.data}
            salons={salons.data?.items ?? []}
            campaign={form.campaign}
            edit={form.edit}
            onDone={() => setForm(null)}
          />
        </Modal>
      )}
      {pause && (
        <Modal title="Пауза вашей стороны" onClose={() => setPause(undefined)}>
          <SimpleForm
            fields={[
              { name: "reason", label: "Причина паузы", type: "textarea" },
            ]}
            onSubmit={async (v) => {
              await api(`/work/${t}/campaigns/${pause.id}/pause`, "POST", {
                expectedVersion: pause.version,
                reason: v.reason,
              });
              setPause(undefined);
            }}
          />
        </Modal>
      )}
      {revoke && (
        <Modal
          title={
            revoke.status === "reserved" || revoke.reservedVisits > 0
              ? "Запросить согласие клиента"
              : "Отозвать купон"
          }
          onClose={() => setRevoke(undefined)}
        >
          <SimpleForm
            fields={[{ name: "reason", label: "Причина", type: "textarea" }]}
            onSubmit={async (v) => {
              await api(
                `/work/${t}/vouchers/${revoke.id}/${revoke.status === "reserved" || revoke.reservedVisits > 0 ? "revocation-requests" : "revoke"}`,
                "POST",
                { expectedVersion: revoke.version, reason: v.reason },
              );
              setRevoke(undefined);
            }}
          />
        </Modal>
      )}
      {exception && (
        <Modal
          title="Результат разбора"
          onClose={() => setException(undefined)}
        >
          <SimpleForm
            fields={[
              {
                name: "resolution",
                label: "Принятое решение",
                type: "textarea",
              },
            ]}
            onSubmit={async (v) => {
              await api(
                `/work/${t}/partner-exceptions/${exception}/resolve`,
                "POST",
                v,
              );
              setException(undefined);
            }}
          />
        </Modal>
      )}
      {history && (
        <Modal title="История версий" onClose={() => setHistory(undefined)}>
          {history.versions.map((v) => (
            <div className="version-card" key={v.id}>
              <h3>
                Версия {v.number} <Badge status={v.status} />
              </h3>
              <p>{v.termsText}</p>
              <p>
                Награда {rewardLabel(v)} · лимит {v.issueLimit??'без лимита'} · срок{' '}
                {v.voucherValidDays?`${v.voucherValidDays} суток`:'без срока'}
              </p>
              <p>
                Выдача: {v.issueFrom?dateTime(v.issueFrom):'с публикации'} — {v.issueUntil?dateTime(v.issueUntil):'без срока'}
              </p>
              <p>Согласовано сторонами: {v.acceptances.length}/2</p>
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}
