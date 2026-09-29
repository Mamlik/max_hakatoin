import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DateTime } from 'luxon';
import { api, useApi, refreshData } from "./api";
import { Badge, Empty, Field, Load, PageTitle, plural, useAction, money, dateTime } from "./ui";
import type { Campaign, Items, Service } from "./types";

export interface LoyaltyReward {
  id: string;
  tenantId: string;
  serviceId: string;
  serviceName: string;
  programName:string;
  status: string;
  publicCode: string;
  tenantName: string;
  rewardType:'fixed'|'percent'|'free_visits';
  fixedDiscountMinor:number|null;discountPercent:number|null;remainingVisits:number;reservedVisits:number;expiresAt:string|null;
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
  name:string;rewardType:'fixed'|'percent'|'free_visits';fixedDiscountMinor:number|null;
  discountPercent:number|null;freeVisitsCount:number|null;startsAt:string|null;endsAt:string|null;
  rewardValidDays:number|null;issueLimit:number|null;issuedTotal:number;status:string;
}
const benefitLabel=(type:string,fixed:number|null,percent:number|null,free:number|null)=>type==='fixed'?`Скидка ${money(fixed)}`:type==='percent'?`Скидка ${percent}%`:`${free??1} бесплатн. посещ.`;
interface PartnerProgram {id:string;activeVersionId:string;sourceName:string;targetName:string;termsText:string;rewardType:string;discountMinor:number|null;discountPercent:number|null;freeVisitsCount:number|null;issueUntil:string|null;issueLimit:number|null;issuedTotal:number;consentGranted:boolean;}

export function LoyaltyPage() {
  const data = useApi<Items<Program>>("/me/loyalty", true);
  const rewards = useApi<Items<LoyaltyReward>>("/me/loyalty-rewards", true);
  const partners=useApi<Items<PartnerProgram>>('/me/campaigns',true);
  const consent=useAction();
  return (
    <>
      <PageTitle
        title="Программы лояльности"
        description="Отметки за платные визиты и отдельные награды каждого салона."
      />
      <Load {...data}>
        <div className="two-columns">
          {data.data?.items.map((p) => (
            <section className="panel" key={p.id}>
              <span className="eyebrow">{p.tenantName}</span>
              <h2>{p.name} · {p.serviceName}</h2>
              <p>
                <strong>
                  {plural(
                    p.visitsRequired,
                    "платное посещение",
                    "платных посещения",
                    "платных посещений",
                  )}
                </strong>{" "}
                → {benefitLabel(p.rewardType,p.fixedDiscountMinor,p.discountPercent,p.freeVisitsCount)}.
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
              <p className="small muted">{p.endsAt?`До ${dateTime(p.endsAt)}`:'Без срока'} · {p.issueLimit===null?'Без лимита':`Осталось наград: ${Math.max(0,p.issueLimit-p.issuedTotal)}`}</p>
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
      <h2>Ваши награды</h2>
      <Load {...rewards}>
        <div className="two-columns">
          {rewards.data?.items.map((r) => (
            <section className="panel" key={r.id}>
              <div className="section-head">
                <span className="eyebrow">{r.tenantName}</span>
                <Badge status={r.status} />
              </div>
              <h3>{r.programName} · {r.serviceName}</h3>
              <p>
                {benefitLabel(r.rewardType,r.fixedDiscountMinor,r.discountPercent,r.remainingVisits)} · {r.expiresAt?`до ${dateTime(r.expiresAt)}`:'без срока'}
              </p>
              {r.status === "issued" && (r.rewardType!=='free_visits'||r.remainingVisits>r.reservedVisits) && (
                <Link
                  className="button primary"
                  to={`/s/${r.publicCode}/book?service=${r.serviceId}&reward=${r.id}`}
                >
                  Использовать награду
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
      <h2>Партнёрские программы</h2>
      <p className="small muted">Согласие действует только для указанной версии условий. Отказ не влияет на обычные отметки и уже выданные купоны.</p>
      {consent.feedback}
      <Load {...partners}>{partners.data?.items.map(c=><section className="panel" key={c.id}><h3>{c.sourceName} → {c.targetName}</h3><p>{c.termsText}</p><p>{benefitLabel(c.rewardType,c.discountMinor,c.discountPercent,c.freeVisitsCount)}</p><p className="small muted">{c.issueUntil?`Выдача до ${dateTime(c.issueUntil)}`:'Выдача без срока'} · {c.issueLimit===null?'Без лимита':`Осталось наград: ${Math.max(0,c.issueLimit-c.issuedTotal)}`}</p><button className="button secondary" disabled={consent.busy} onClick={()=>void consent.run(async()=>{await api(`/me/campaigns/${c.id}/consent`,'PUT',{versionId:c.activeVersionId,granted:!c.consentGranted});refreshData();},c.consentGranted?'Согласие отозвано':'Согласие сохранено')}>{c.consentGranted?'Отозвать согласие':'Согласиться с условиями'}</button></section>)}</Load>
      <p className="small muted">
        Награды не суммируются между собой или с акцией. Оплата услуг происходит в салоне.
      </p>
    </>
  );
}

export function LoyaltySettingsPage() {
  const { t } = useParams();
  const [editing,setEditing]=useState<Program|null>(null);
  const programs = useApi<Items<Program>>(`/work/${t}/loyalty-programs`, true);
  const campaigns = useApi<Items<Campaign>>(`/work/${t}/campaigns`, true);
  const services = useApi<Items<Service>>(`/work/${t}/services`);
  const salon=useApi<{timezone:string}>(`/work/${t}/profile`);
  return (
    <>
      <PageTitle
        title="Лояльность салона"
        description="Собственные программы и совместные предложения с другими салонами."
      />
      <section className="panel loyalty-overview"><div className="section-head"><h2>Свои программы</h2><span className="muted">{programs.data ? plural(programs.data.items.length, "программа", "программы", "программ") : "…"}</span></div>
        <Load {...programs}>{programs.data?.items.length ? programs.data.items.map((program) => <div className="history-row" key={program.id}><div><strong>{program.name}</strong><p>{program.serviceName} · {benefitLabel(program.rewardType, program.fixedDiscountMinor, program.discountPercent, program.freeVisitsCount)}</p></div><Badge status={program.status} /></div>) : <Empty title="Программ пока нет" text="Создайте первую программу ниже." />}</Load>
      </section>
      <section className="panel loyalty-overview"><div className="section-head"><h2>Совместная лояльность</h2><Link to={`/work/${t}/partners`}>Условия и действия →</Link></div>
        <Load {...campaigns}>{campaigns.data?.items.length ? campaigns.data.items.map((campaign) => <div className="history-row" key={campaign.id}><div><strong>{campaign.sourceName} → {campaign.targetName}</strong><p>{campaign.pendingVersionId ? "Ожидает решения по условиям" : campaign.pauses.length ? "На паузе" : "Действующие условия и история версий"}</p></div><Badge status={campaign.status} /></div>) : <Empty title="Совместных программ пока нет" text="Здесь появятся партнёрства и предложения, ожидающие решения." />}</Load>
      </section>
      <div className="profile-links"><Link to={`/work/${t}/promotions`}>Временные акции →</Link></div>
      <p className="notice">
        Например, 5 платных стрижек + 1 бесплатная. Засчитываются только
        завершённые визиты с ненулевой стоимостью. Порог фиксируется после
        первой отметки, чтобы сохранить условия для клиентов.
      </p>
      <Load
        loading={programs.loading || services.loading}
        error={programs.error || services.error}
      >
        <NewProgram key={editing?.id??'new'} editing={editing} onDone={()=>setEditing(null)} tenantId={t!} services={services.data?.items.filter(s=>s.active)??[]} zone={salon.data?.timezone??'Europe/Moscow'}/>
        <h2>Действующие и завершённые программы</h2>
        <div className="two-columns">{programs.data?.items.map(p=><section className="panel" key={p.id}><span className="eyebrow">{p.serviceName}</span><h3>{p.name}</h3><p>{p.visitsRequired} посещений → {benefitLabel(p.rewardType,p.fixedDiscountMinor,p.discountPercent,p.freeVisitsCount)}</p><p><Badge status={p.status}/> · выдано {p.issuedTotal}{p.issueLimit!==null?` из ${p.issueLimit}`:''}</p><p className="small muted">{p.endsAt?`До ${dateTime(p.endsAt)}`:'Без срока'} · награда {p.rewardValidDays?`${p.rewardValidDays} дн.`:'без срока'}</p>{!p.hasActivity&&<button className="button secondary" onClick={()=>setEditing(p)}>Изменить условия</button>}{['active','paused'].includes(p.status)&&<ProgramActions program={p} tenantId={t!}/>}</section>)}</div>
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
function ProgramActions({program,tenantId}:{program:Program;tenantId:string}){
  const action=useAction();return <div className="inline-actions">{[program.status==='active'?'pause':'resume','end'].map(kind=><button key={kind} className="button secondary" disabled={action.busy} onClick={()=>void action.run(async()=>{await api(`/work/${tenantId}/loyalty-programs/${program.id}/${kind}`,'POST',{expectedVersion:program.version});refreshData();},kind==='end'?'Программа завершена':'Статус обновлён')}>{kind==='pause'?'Пауза':kind==='resume'?'Продолжить':'Завершить'}</button>)}{action.feedback}</div>;
}
function NewProgram({tenantId,services,zone,editing,onDone}:{tenantId:string;services:Service[];zone:string;editing:Program|null;onDone:()=>void}){
  const local=(v:string|null)=>v?DateTime.fromISO(v).setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"):'';
  const [serviceId,setServiceId]=useState(editing?.serviceId??'');
  const [name,setName]=useState(editing?.name??'Награда за посещения');
  const [visits,setVisits]=useState(editing?.visitsRequired??5);
  const [kind,setKind]=useState<'fixed'|'percent'|'free_visits'>(editing?.rewardType??'free_visits');
  const [amount,setAmount]=useState(editing?.rewardType==='fixed'?(editing.fixedDiscountMinor??0)/100:editing?.rewardType==='percent'?editing.discountPercent??1:editing?.freeVisitsCount??1);
  const [start,setStart]=useState(local(editing?.startsAt??null));
  const [end,setEnd]=useState(local(editing?.endsAt??null));
  const [days,setDays]=useState(editing?.rewardValidDays?.toString()??'');
  const [limit,setLimit]=useState(editing?.issueLimit?.toString()??'');
  const action=useAction();
  const instant=(value:string)=>value?DateTime.fromISO(value,{zone}).toUTC().toISO():null;
  const save=()=>void action.run(async()=>{
    await api(`/work/${tenantId}/loyalty-programs${editing?`/${editing.id}`:''}`,editing?'PATCH':'POST',{
      name:name.trim(),serviceId,visitsRequired:visits,rewardType:kind,
      fixedDiscountMinor:kind==='fixed'?Math.round(amount*100):null,
      discountPercent:kind==='percent'?amount:null,
      freeVisitsCount:kind==='free_visits'?amount:null,
      startsAt:instant(start),endsAt:instant(end),rewardValidDays:days?Number(days):null,
      issueLimit:limit?Number(limit):null,
      ...(editing?{expectedVersion:editing.version}:{})
    });onDone();refreshData();
  },editing?'Программа обновлена':'Программа создана');
  return <section className="panel">
    <h2>{editing?'Изменить программу':'Новая программа'}</h2>
    <p className="small muted">После первой отметки условия фиксируются. Для других условий создайте ещё одну программу.</p>
    <div className="two-columns">
      <Field label="Название"><input value={name} onChange={e=>setName(e.target.value)}/></Field>
      <Field label="Услуга"><select value={serviceId} onChange={e=>setServiceId(e.target.value)}><option value="">Выберите услугу</option>{services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Платных посещений до награды"><input type="number" min={2} max={50} value={visits} onChange={e=>setVisits(Number(e.target.value))}/></Field>
      <Field label="Тип награды"><select value={kind} onChange={e=>{setKind(e.target.value as typeof kind);setAmount(1);}}><option value="free_visits">Бесплатные посещения</option><option value="fixed">Скидка в рублях</option><option value="percent">Процентная скидка</option></select></Field>
      <Field label={kind==='free_visits'?'Число бесплатных посещений':kind==='fixed'?'Скидка, ₽':'Скидка, %'}><input type="number" min={1} max={kind==='percent'?100:kind==='free_visits'?50:undefined} value={amount} onChange={e=>setAmount(Number(e.target.value))}/></Field>
      <Field label={`Начало (${zone}, необязательно)`}><input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/></Field>
      <Field label={`Окончание (${zone}, необязательно)`}><input type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}/></Field>
      <Field label="Срок награды, дней (пусто — без срока)"><input type="number" min={1} max={365} value={days} onChange={e=>setDays(e.target.value)}/></Field>
      <Field label="Лимит выдачи (пусто — без лимита)"><input type="number" min={1} value={limit} onChange={e=>setLimit(e.target.value)}/></Field>
    </div>
    <div className="inline-actions"><button className="button primary" disabled={action.busy||!serviceId||!name.trim()} onClick={save}>{editing?'Сохранить':'Создать программу'}</button>{editing&&<button className="button secondary" onClick={onDone}>Отмена</button>}</div>
    {action.feedback}
  </section>;
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
            посещений · наград доступно: {p.availableRewards}
          </p>
        ))}
        {!data.data?.items.length && (
          <p>Программы для этого салона ещё не настроены.</p>
        )}
      </Load>
    </section>
  );
}
