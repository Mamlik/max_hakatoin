import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, refreshData, useApi } from "./api";
import { BackLink, Badge, Empty, Field, Load, PageTitle, dateTime, dayISO, useAction } from "./ui";
import type { Catalog, Items, LiveWindowOffer, Salon, WaitlistRequest } from "./types";

const weekdays = [
  [1, "Пн"], [2, "Вт"], [3, "Ср"], [4, "Чт"], [5, "Пт"], [6, "Сб"], [7, "Вс"],
] as const;

export function WaitlistPage() {
  const data = useApi<Items<WaitlistRequest>>("/me/waitlist-requests", true);
  const action = useAction();
  return <>
    <PageTitle eyebrow="ЖИВОЕ ОКНО" title="Ожидаем удобное время" description="Запрос не является записью и не резервирует слот. Мы предложим время после отмены, если оно подойдёт." />
    {action.feedback}
    <Load {...data}>
      {data.data?.items.length ? <div className="data-list">{data.data.items.map((request) => <div className="history-row" key={request.id}>
        <div><strong>{request.dateFrom} — {request.dateTo}</strong><p>{request.dailyStartLocal.slice(0,5)}–{request.dailyEndLocal.slice(0,5)} · {request.staffIds.length ? `${request.staffIds.length} маст.` : "любой мастер"}</p>{request.suspensionReason && <small>{request.suspensionReason}</small>}</div>
        <Badge status={request.status} />
        <div className="inline-actions">
          {request.offer?.status === "offered" && <Link className="button primary compact" to={`/me/live-window/offers/${request.offer.id}`}>Открыть предложение</Link>}
          {request.status === "active" && <button className="button secondary compact" onClick={() => void action.run(() => api(`/me/waitlist-requests/${request.id}/pause`,"POST",{expectedVersion:request.version}),"Запрос приостановлен")}>Пауза</button>}
          {["paused","paused_channel_unavailable"].includes(request.status) && <button className="button secondary compact" onClick={() => void action.run(() => api(`/me/waitlist-requests/${request.id}/resume`,"POST",{expectedVersion:request.version}),"Запрос возобновлён")}>Возобновить</button>}
          {["active","paused","paused_channel_unavailable","suspended_incompatible"].includes(request.status) && <button className="text-button" onClick={() => void action.run(() => api(`/me/waitlist-requests/${request.id}/cancel`,"POST",{expectedVersion:request.version}),"Запрос закрыт")}>Закрыть</button>}
        </div>
      </div>)}</div> : <Empty title="Нет запросов ожидания" text="Откройте запись в салон и выберите «Сообщить, если время освободится»." />}
    </Load>
  </>;
}

export function WaitlistForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = params.get("code") ?? "";
  const salon = useApi<Salon>(code ? `/public/salons/${code}` : null);
  const catalog = useApi<Catalog>(code ? `/public/salons/${code}/catalog` : null);
  const [serviceId,setServiceId] = useState(params.get("service") ?? "");
  const [staffIds,setStaffIds] = useState<string[]>(params.get("staff") ? [params.get("staff")!] : []);
  const [dateFrom,setDateFrom] = useState(dayISO(1));
  const [dateTo,setDateTo] = useState(dayISO(14));
  const [days,setDays] = useState<number[]>([1,2,3,4,5,6,7]);
  const [start,setStart] = useState("09:00");
  const [end,setEnd] = useState("21:00");
  const [notice,setNotice] = useState(60);
  const action = useAction();
  const availableStaff = useMemo(() => catalog.data?.staff.filter((staff) => staff.serviceIds.includes(serviceId)) ?? [],[catalog.data,serviceId]);
  async function submit() {
    if (!salon.data || !serviceId || !days.length) return;
    await action.run(async () => {
      await api("/me/waitlist-requests","POST",{
        tenantId:salon.data!.id,serviceId,staffIds,dateFrom,dateTo,weekdays:days,dailyStartLocal:start,dailyEndLocal:end,minimumNoticeMinutes:notice,
        ...(params.get("linked") ? {linkedBookingId:params.get("linked")} : {}),consentVersion:"live-window-v1",consentSource:"mini_app",
      });
      refreshData(); navigate("/me/waitlist");
    },"Запрос создан");
  }
  return <>
    <BackLink to={params.get("linked") ? `/me/bookings/${params.get("linked")}` : code ? `/s/${code}/book` : "/me/waitlist"} />
    <PageTitle eyebrow={salon.data?.name ?? "ЖИВОЕ ОКНО"} title={params.get("linked") ? "Хочу перенести запись раньше" : "Сообщить об освободившемся времени"} description="Укажите подходящий диапазон. Предложение не удерживает время: запись создаётся только после вашего подтверждения." />
    {action.feedback}
    {!code ? <Empty title="Не выбран салон" text="Откройте форму из страницы записи выбранного салона." /> : <Load loading={salon.loading || catalog.loading} error={salon.error || catalog.error}>
      <section className="panel live-window-form">
        <Field label="Услуга"><select value={serviceId} onChange={(event)=>{setServiceId(event.target.value);setStaffIds([])}}><option value="">Выберите услугу</option>{catalog.data?.services.map((service)=><option key={service.id} value={service.id}>{service.name} · {service.durationMin} мин</option>)}</select></Field>
        <Field label="Мастера"><div className="checklist">{availableStaff.map((staff)=><label className="check" key={staff.id}><input type="checkbox" checked={staffIds.includes(staff.id)} onChange={(event)=>setStaffIds((old)=>event.target.checked?[...old,staff.id]:old.filter((id)=>id!==staff.id))}/><span>{staff.name}</span></label>)}</div><small>Если никого не выбрать, подойдёт любой мастер услуги.</small></Field>
        <div className="two-columns"><Field label="С даты"><input type="date" min={dayISO()} max={dayISO(30)} value={dateFrom} onChange={(event)=>setDateFrom(event.target.value)}/></Field><Field label="По дату"><input type="date" min={dateFrom} max={dayISO(30)} value={dateTo} onChange={(event)=>setDateTo(event.target.value)}/></Field></div>
        <Field label="Дни недели"><div className="inline-actions">{weekdays.map(([number,label])=><label className="check" key={number}><input type="checkbox" checked={days.includes(number)} onChange={(event)=>setDays((old)=>event.target.checked?[...old,number]:old.filter((day)=>day!==number))}/><span>{label}</span></label>)}</div></Field>
        <div className="two-columns"><Field label="Не раньше"><input type="time" value={start} onChange={(event)=>setStart(event.target.value)}/></Field><Field label="Не позже"><input type="time" value={end} onChange={(event)=>setEnd(event.target.value)}/></Field></div>
        <Field label="Минимум времени до визита"><select value={notice} onChange={(event)=>setNotice(Number(event.target.value))}><option value={60}>1 час</option><option value={120}>2 часа</option><option value={360}>6 часов</option><option value={1440}>1 день</option></select></Field>
        <div className="notice">Это запрос ожидания, а не запись. Если время освободится, бот MAX пришлёт одно предложение с ограниченным сроком. Слот останется доступен другим клиентам до подтверждения.</div>
        <button className="button primary" disabled={action.busy || !serviceId || !days.length} onClick={()=>void submit()}>{action.busy?"Создаём…":"Создать запрос"}</button>
      </section>
    </Load>}
  </>;
}

export function LiveWindowOfferPage() {
  const { id } = useParams();
  const data = useApi<LiveWindowOffer>(`/me/live-window-offers/${id}`,true);
  const action = useAction();
  const navigate = useNavigate();
  const active = data.data?.status === "offered" && !!data.data.expiresAt && new Date(data.data.expiresAt).getTime()>Date.now();
  return <>
    <BackLink to="/me/waitlist" />
    <PageTitle eyebrow="ЖИВОЕ ОКНО" title="Освободилось подходящее время" description="Время доступно другим клиентам и не зарезервировано." />
    {action.feedback}
    <Load {...data}>{data.data && <section className="panel"><div className="section-head"><h2>{data.data.serviceName}</h2><Badge status={data.data.status}/></div><dl><dt>Салон</dt><dd>{data.data.tenantName}</dd><dt>Мастер</dt><dd>{data.data.staffName}</dd><dt>Начало</dt><dd>{dateTime(data.data.startAt,data.data.timezone)}</dd><dt>Ссылка действует до</dt><dd>{data.data.expiresAt?dateTime(data.data.expiresAt,data.data.timezone):"—"}</dd></dl><div className="notice">Предложение не является бронью. Сервер ещё раз проверит слот в момент подтверждения.</div>{active?<div className="inline-actions"><button className="button primary" disabled={action.busy} onClick={()=>void action.run(async()=>{const result=await api<{status:string;booking?:{id:string}}>(`/me/live-window-offers/${id}/accept`,"POST",{expectedVersion:data.data!.version,confirmedTermsVersion:"booking-p0-v1"});refreshData();if(result.booking)navigate(`/me/bookings/${result.booking.id}`);},"")}>{data.data.linkedBookingId?"Перенести мою запись":"Записаться"}</button><button className="button secondary" disabled={action.busy} onClick={()=>void action.run(async()=>{await api(`/me/live-window-offers/${id}/decline`,"POST",{expectedVersion:data.data!.version,stopRequest:false});navigate("/me/waitlist")},"Предложение отклонено")}>Не подходит</button><button className="text-button" disabled={action.busy} onClick={()=>void action.run(async()=>{await api(`/me/live-window-offers/${id}/decline`,"POST",{expectedVersion:data.data!.version,stopRequest:true});navigate("/me/waitlist")},"Запрос закрыт")}>Больше не предлагать</button></div>:<p className="muted">Предложение уже недоступно. Запрос продолжит ждать другое подходящее время, если он активен.</p>}</section>}</Load>
  </>;
}

type Settings = {enabled:boolean;paused:boolean;pauseReason:string|null;offerTtlMinutes:number;minimumNoticeMinutes:number;quietStart:string;quietEnd:string;version:number};
type WindowRow = {id:string;status:string;serviceName:string;staffName:string;startAt:string;timezoneSnapshot:string;version:number;offers:{sequence:number;status:string;terminalReason:string|null}[]};
export function LiveWindowWorkPage() {
  const {t}=useParams();
  const settings=useApi<Settings>(`/work/${t}/live-window/settings`,true);
  const windows=useApi<Items<WindowRow>>(`/work/${t}/live-window/windows`,true);
  const summary=useApi<{activeRequests:number;activeWindows:number;filledWindows:number;lostOffers:number;deadEvents:number}>(`/work/${t}/live-window/summary`,true);
  const action=useAction();
  const [draft,setDraft]=useState<Settings>();
  const value=draft??settings.data;
  return <><PageTitle eyebrow="АВТОМАТИЧЕСКОЕ ЗАПОЛНЕНИЕ ОТМЕН" title="Живое окно" description="FIFO-очередь предлагает отменённый интервал одному подходящему клиенту за раз." />{action.feedback}<div className="stats-grid compact-stats"><div className="stat-card"><span>Активные запросы</span><strong>{summary.data?.activeRequests??"—"}</strong></div><div className="stat-card"><span>Окна в работе</span><strong>{summary.data?.activeWindows??"—"}</strong></div><div className="stat-card"><span>Заполнено</span><strong>{summary.data?.filledWindows??"—"}</strong></div></div><Load {...settings}>{value&&<section className="panel"><h2>Настройки</h2><label className="check"><input type="checkbox" checked={value.enabled} onChange={(event)=>setDraft({...value,enabled:event.target.checked})}/><span>Включить автоматические предложения после отмены</span></label><label className="check"><input type="checkbox" checked={value.paused} onChange={(event)=>setDraft({...value,paused:event.target.checked})}/><span>Операционная пауза</span></label><div className="two-columns"><Field label="TTL предложения"><input type="number" min={5} max={30} value={value.offerTtlMinutes} onChange={(event)=>setDraft({...value,offerTtlMinutes:Number(event.target.value)})}/></Field><Field label="Минимум до визита"><input type="number" min={0} value={value.minimumNoticeMinutes} onChange={(event)=>setDraft({...value,minimumNoticeMinutes:Number(event.target.value)})}/></Field><Field label="Сообщения с"><input type="time" value={value.quietStart.slice(0,5)} onChange={(event)=>setDraft({...value,quietStart:event.target.value})}/></Field><Field label="Сообщения до"><input type="time" value={value.quietEnd.slice(0,5)} onChange={(event)=>setDraft({...value,quietEnd:event.target.value})}/></Field></div><div className="notice">После включения предложения отправляются автоматически. Администратор не может менять FIFO или выбирать клиента вручную.</div><button className="button primary" disabled={action.busy} onClick={()=>void action.run(async()=>{await api(`/work/${t}/live-window/settings`,"PATCH",{expectedVersion:value.version,enabled:value.enabled,paused:value.paused,pauseReason:value.paused?"Операционная пауза":null,offerTtlMinutes:value.offerTtlMinutes,minimumNoticeMinutes:value.minimumNoticeMinutes,quietStart:value.quietStart.slice(0,5),quietEnd:value.quietEnd.slice(0,5)});setDraft(undefined);refreshData()},"Настройки сохранены")}>Сохранить</button></section>}</Load><h2>Последние окна</h2><Load {...windows}>{windows.data?.items.length?<div className="data-list">{windows.data.items.map((window)=><div className="history-row" key={window.id}><div><strong>{window.serviceName} · {window.staffName}</strong><p>{dateTime(window.startAt,window.timezoneSnapshot)} · {window.offers.length} предлож.</p></div><Badge status={window.status}/>{["detected","matching","offering"].includes(window.status)&&<button className="text-button" onClick={()=>void action.run(()=>api(`/work/${t}/live-window/windows/${window.id}/close`,"POST",{expectedVersion:window.version,reason:"Закрыто сотрудником"}),"Окно закрыто")}>Закрыть</button>}</div>)}</div>:<Empty title="Окон пока нет" text="Они появятся после отмены или обычного переноса подтверждённой записи."/>}</Load></>;
}
