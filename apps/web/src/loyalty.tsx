import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useApi } from "./api";
import { Badge, Empty, Field, Load, PageTitle, useAction } from "./ui";
import type { Items, Service } from "./types";

export interface LoyaltyReward {
  id: string;
  tenantId: string;
  serviceId: string;
  serviceName: string;
  status: string;
  publicCode: string;
  tenantName: string;
}
interface Program {
  id: string;
  serviceId: string;
  serviceName: string;
  tenantName: string;
  publicCode: string;
  visitsRequired: number;
  progress: number;
  availableRewards: number;
  enabled: boolean;
  version: number;
  hasActivity?: boolean;
}

export function LoyaltyPage() {
  const data = useApi<Items<Program>>("/me/loyalty", true);
  const rewards = useApi<Items<LoyaltyReward>>("/me/loyalty-rewards", true);
  return (
    <>
      <PageTitle
        title="Бесплатные посещения"
        description="Посещайте любимого мастера, собирайте отметки и получайте дополнительный визит бесплатно."
      />
      <Load {...data}>
        <div className="two-columns">
          {data.data?.items.map((p) => (
            <section className="panel" key={p.id}>
              <span className="eyebrow">{p.tenantName}</span>
              <h2>{p.serviceName}</h2>
              <p>
                Каждые <strong>{p.visitsRequired} платных посещений</strong> →
                ещё одно бесплатно.
              </p>
              <progress
                className="loyalty-progress"
                value={p.progress}
                max={p.visitsRequired}
                aria-label={`Накоплено ${p.progress} из ${p.visitsRequired} посещений`}
              />
              <p>
                <strong>
                  {p.progress} из {p.visitsRequired}
                </strong>{" "}
                · до следующего подарка:{" "}
                {Math.max(0, p.visitsRequired - p.progress)}
              </p>
              {!p.enabled && (
                <p className="notice">
                  Накопление приостановлено. Ваши отметки и выданные награды
                  сохраняются.
                </p>
              )}
              <Link
                className="button secondary"
                to={`/s/${p.publicCode}/book?service=${p.serviceId}`}
              >
                Выбрать время
              </Link>
            </section>
          ))}
        </div>
        {!data.data?.items.length && (
          <Empty
            title="Программы ещё не настроены"
            text="Когда салон включит программу, здесь появится ваша карточка посещений."
          />
        )}
      </Load>
      <h2>Ваши бесплатные визиты</h2>
      <Load {...rewards}>
        <div className="two-columns">
          {rewards.data?.items.map((r) => (
            <section className="panel" key={r.id}>
              <div className="section-head">
                <span className="eyebrow">{r.tenantName}</span>
                <Badge status={r.status} />
              </div>
              <h3>{r.serviceName}</h3>
              <p>
                Одно посещение · <strong>0 ₽</strong>
              </p>
              {r.status === "issued" && (
                <Link
                  className="button primary"
                  to={`/s/${r.publicCode}/book?service=${r.serviceId}&reward=${r.id}`}
                >
                  Записаться бесплатно
                </Link>
              )}
              {r.status === "reserved" && (
                <p>
                  Награда закреплена за вашей записью. При отмене или неявке она
                  станет доступна снова.
                </p>
              )}
            </section>
          ))}
        </div>
        {!rewards.data?.items.length && (
          <Empty
            title="Первая награда впереди"
            text="Отметка появится, когда сотрудник завершит ваш платный визит. Бесплатные визиты не дают новых отметок."
          />
        )}
      </Load>
      <p className="small muted">
        Посещения учитываются отдельно для каждой услуги и салона с момента
        включения программы. Награды не сгорают и не суммируются с партнёрским
        купоном. Оплата услуг происходит в салоне.
      </p>
    </>
  );
}

export function LoyaltySettingsPage() {
  const { t } = useParams();
  const programs = useApi<Items<Program>>(`/work/${t}/loyalty-programs`, true);
  const services = useApi<Items<Service>>(`/work/${t}/services`);
  return (
    <>
      <PageTitle
        title="Программа лояльности"
        description="Задайте число платных посещений услуги, после которых клиент получает ещё одно посещение бесплатно."
      />
      <p className="notice">
        Например, 5 платных стрижек + 1 бесплатная. Засчитываются только
        завершённые визиты с ненулевой стоимостью. Порог фиксируется после
        первой отметки, чтобы сохранить условия для клиентов.
      </p>
      <Load
        loading={programs.loading || services.loading}
        error={programs.error || services.error}
      >
        <div className="two-columns">
          {services.data?.items
            .filter((s) => s.active)
            .map((s) => (
              <ProgramForm
                key={`${s.id}:${programs.data?.items.find((p) => p.serviceId === s.id)?.version ?? 0}`}
                service={s}
                program={programs.data?.items.find((p) => p.serviceId === s.id)}
                tenantId={t!}
              />
            ))}
        </div>
        {!services.data?.items.some((s) => s.active) && (
          <Empty
            title="Сначала добавьте услугу"
            action={<Link to={`/work/${t}/catalog`}>Открыть каталог</Link>}
          />
        )}
      </Load>
    </>
  );
}
function ProgramForm({
  service,
  program,
  tenantId,
}: {
  service: Service;
  program?: Program;
  tenantId: string;
}) {
  const [visits, setVisits] = useState(program?.visitsRequired ?? 5);
  const action = useAction();
  const save = (enabled: boolean) =>
    action.run(() =>
      api(`/work/${tenantId}/loyalty-programs`, "PUT", {
        serviceId: service.id,
        visitsRequired: visits,
        enabled,
        expectedVersion: program?.version ?? 0,
      }),
    );
  return (
    <section className="panel">
      <h2>{service.name}</h2>
      <p>
        {program?.enabled
          ? "Накопление включено"
          : program
            ? "Накопление приостановлено"
            : "Программа пока не включена"}
      </p>
      <Field
        label="Платных посещений до подарка"
        hint="От 2 до 50. Подарок — ещё одно посещение этой же услуги."
      >
        <input
          type="number"
          min={2}
          max={50}
          step={1}
          value={visits}
          disabled={program?.hasActivity}
          onChange={(e) => setVisits(Number(e.target.value))}
        />
      </Field>
      <div className="inline-actions">
        <button
          className="button primary"
          disabled={
            action.busy ||
            !Number.isInteger(visits) ||
            visits < 2 ||
            visits > 50
          }
          onClick={() => void save(true)}
        >
          {program?.enabled ? "Сохранить" : "Включить программу"}
        </button>
        {program?.enabled && (
          <button
            className="button secondary"
            disabled={action.busy}
            onClick={() => void save(false)}
          >
            Приостановить
          </button>
        )}
      </div>
      {action.feedback}
      {program?.hasActivity && (
        <p className="small muted">
          Порог закреплён: у клиентов уже есть отметки. Пауза останавливает
          новые начисления, но сохраняет награды.
        </p>
      )}
    </section>
  );
}

export function CustomerLoyalty({
  tenantId,
  customerId,
}: {
  tenantId: string;
  customerId: string;
}) {
  const data = useApi<{ items: Program[]; rewards: LoyaltyReward[] }>(
    `/work/${tenantId}/customers/${customerId}/loyalty`,
    true,
  );
  return (
    <section className="panel">
      <h2>Лояльность клиента</h2>
      <Load {...data}>
        {data.data?.items.map((p) => (
          <p key={p.id}>
            <strong>{p.serviceName}</strong>: {p.progress} из {p.visitsRequired}{" "}
            посещений · бесплатных визитов доступно: {p.availableRewards}
          </p>
        ))}
        {!data.data?.items.length && (
          <p>Программы для этого салона ещё не настроены.</p>
        )}
      </Load>
    </section>
  );
}
