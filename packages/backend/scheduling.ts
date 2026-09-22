import { DateTime } from "luxon";
import type { DB } from "../db/db.js";
import { one, rows } from "../db/db.js";
import { fail, required } from "./errors.js";
import type { Interval, Weekday, Tenant, Service, Staff } from "./types.js";
import { config } from "./config.js";

export function validateIntervals(intervals: Interval[]) {
  for (const i of intervals)
    if (i.start >= i.end)
      fail(
        422,
        "VALIDATION_ERROR",
        "Конец интервала должен быть позже начала. Ночную смену разделите по дням.",
      );
  for (const kind of ["work", "break"]) {
    const selected = intervals
      .filter((i) => i.kind === kind)
      .sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 1; i < selected.length; i++)
      if (selected[i]!.start < selected[i - 1]!.end)
        fail(422, "VALIDATION_ERROR", "Интервалы одного типа пересекаются");
  }
  for (const b of intervals.filter((i) => i.kind === "break"))
    if (
      !intervals.some(
        (w) => w.kind === "work" && w.start <= b.start && w.end >= b.end,
      )
    )
      fail(
        422,
        "VALIDATION_ERROR",
        "Перерыв должен находиться внутри рабочего интервала",
      );
}
export function utcIntervals(
  date: string,
  timezone: string,
  intervals: Interval[],
): [number, number][] {
  validateIntervals(intervals);
  const instant = (time: string) => {
    const dt = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
    if (
      !dt.isValid ||
      dt.toFormat("HH:mm") !== time ||
      dt.toISODate() !== date ||
      dt.getPossibleOffsets().length > 1
    )
      fail(
        422,
        "AMBIGUOUS_SCHEDULE",
        "Граница графика попала на перевод часов. Укажите другое время.",
      );
    return dt.toMillis();
  };
  const breaks = intervals
    .filter((i) => i.kind === "break")
    .map((i) => [instant(i.start), instant(i.end)] as [number, number]);
  return intervals
    .filter((i) => i.kind === "work")
    .flatMap((i) => {
      let pieces: [number, number][] = [[instant(i.start), instant(i.end)]];
      for (const [bs, be] of breaks)
        pieces = pieces.flatMap(([s, e]) =>
          be <= s || bs >= e
            ? [[s, e] as [number, number]]
            : ([
                [s, Math.max(s, bs)],
                [Math.min(e, be), e],
              ].filter(([a, b]) => b! > a!) as [number, number][]),
        );
      return pieces;
    });
}
export async function dayIntervals(
  db: DB,
  tenant: Tenant,
  staffId: string,
  date: string,
  useSnapshot = false,
): Promise<[number, number][]> {
  if (useSnapshot) {
    const snapshot = await one<{ intervals: [number, number][] }>(
      db,
      "SELECT intervals FROM schedule_snapshots WHERE staff_id=$1 AND local_date=$2",
      [staffId, date],
    );
    if (snapshot) return snapshot.intervals;
  }
  const exception = await one<{ mode: string; intervals: Interval[] }>(
    db,
    "SELECT * FROM schedule_exceptions WHERE staff_id=$1 AND local_date=$2",
    [staffId, date],
  );
  if (exception)
    return exception.mode === "closed"
      ? []
      : utcIntervals(date, tenant.timezone, exception.intervals);
  const rule = await one<{ weekly: Weekday[] }>(
    db,
    "SELECT weekly FROM schedules WHERE staff_id=$1 AND effective_from<=$2 ORDER BY effective_from DESC,version DESC LIMIT 1",
    [staffId, date],
  );
  return utcIntervals(
    date,
    tenant.timezone,
    rule?.weekly.find(
      (w) =>
        w.weekday === DateTime.fromISO(date, { zone: tenant.timezone }).weekday,
    )?.intervals ?? [],
  );
}
export async function checkSlot(
  db: DB,
  tenant: Tenant,
  service: Service,
  staff: Staff,
  startAt: string,
  duration = service.duration_min,
  excludeBooking?: string,
) {
  const start = DateTime.fromISO(startAt, { setZone: true }).setZone(
    tenant.timezone,
  );
  const now = DateTime.now().setZone(tenant.timezone);
  if (
    !start.isValid ||
    start.toMillis() <= Date.now() ||
    start > now.plus({ days: config.BOOKING_HORIZON_DAYS }) ||
    start.minute % config.SLOT_STEP_MINUTES !== 0 ||
    start.second !== 0 ||
    start.millisecond !== 0
  )
    fail(409, "SLOT_UNAVAILABLE", "Время недоступно для записи");
  if (
    !service.active ||
    !staff.active ||
    !(await one(
      db,
      "SELECT 1 FROM staff_services WHERE tenant_id=$1 AND staff_id=$2 AND service_id=$3",
      [tenant.id, staff.id, service.id],
    ))
  )
    fail(409, "SLOT_UNAVAILABLE", "Мастер не оказывает выбранную услугу");
  const end = start.toMillis() + duration * 60000;
  const ranges = await dayIntervals(db, tenant, staff.id, start.toISODate()!);
  if (!ranges.some(([s, e]) => start.toMillis() >= s && end <= e))
    fail(409, "SLOT_UNAVAILABLE", "Время не входит в рабочий график");
  if (
    await one(
      db,
      "SELECT id FROM bookings WHERE staff_id=$1 AND status<>'cancelled' AND start_at<$3 AND end_at>$2 AND ($4::uuid IS NULL OR id<>$4) LIMIT 1",
      [staff.id, start.toJSDate(), new Date(end), excludeBooking ?? null],
    )
  )
    fail(409, "SLOT_UNAVAILABLE", "Это время уже занято. Выберите другое.");
  return new Date(end).toISOString();
}
export async function slots(
  db: DB,
  tenant: Tenant,
  serviceId: string,
  from: string,
  to: string,
  staffId?: string,
  excludeBooking?: string,
  duration?: number,
) {
  const service = required(
    await one<Service>(
      db,
      "SELECT * FROM services WHERE tenant_id=$1 AND id=$2 AND active",
      [tenant.id, serviceId],
    ),
  );
  const first = DateTime.fromISO(from, { zone: tenant.timezone }).startOf(
    "day",
  );
  const last = DateTime.fromISO(to, { zone: tenant.timezone }).endOf("day");
  if (
    !first.isValid ||
    !last.isValid ||
    last < first ||
    last.diff(first, "days").days > 31
  )
    fail(422, "VALIDATION_ERROR", "Допустим диапазон до 30 дней");
  const workers = await rows<Staff>(
    db,
    "SELECT s.* FROM staff s JOIN staff_services ss ON ss.staff_id=s.id WHERE ss.service_id=$1 AND s.tenant_id=$2 AND s.active AND ($3::uuid IS NULL OR s.id=$3) ORDER BY s.name,s.id",
    [serviceId, tenant.id, staffId ?? null],
  );
  const busy = await rows<{ staff_id: string; start_at: Date; end_at: Date }>(
    db,
    "SELECT staff_id,start_at,end_at FROM bookings WHERE tenant_id=$1 AND status<>'cancelled' AND start_at<$3 AND end_at>$2 AND ($4::uuid IS NULL OR id<>$4)",
    [tenant.id, first.toJSDate(), last.toJSDate(), excludeBooking ?? null],
  );
  const result: Record<string, unknown>[] = [];
  const now = Date.now();
  const max = DateTime.now()
    .plus({ days: config.BOOKING_HORIZON_DAYS })
    .toMillis();
  for (let day = first; day <= last; day = day.plus({ days: 1 }))
    for (const worker of workers) {
      const ranges = await dayIntervals(
        db,
        tenant,
        worker.id,
        day.toISODate()!,
      );
      for (const [s, e] of ranges)
        for (
          let ts = s;
          ts + (duration ?? service.duration_min) * 60000 <= e;
          ts += 60000
        ) {
          const dt = DateTime.fromMillis(ts, { zone: tenant.timezone });
          if (
            dt.minute % config.SLOT_STEP_MINUTES !== 0 ||
            ts <= now ||
            ts > max
          )
            continue;
          const end = ts + (duration ?? service.duration_min) * 60000;
          if (
            busy.some(
              (b) =>
                b.staff_id === worker.id &&
                b.start_at.getTime() < end &&
                b.end_at.getTime() > ts,
            )
          )
            continue;
          result.push({
            staffId: worker.id,
            staffName: worker.name,
            startAt: new Date(ts).toISOString(),
            endAt: new Date(end).toISOString(),
            timezone: tenant.timezone,
            priceMinor: service.price_minor,
            serviceVersion: service.version,
            scheduleVersion: worker.version,
          });
          if (result.length >= 1500) return result;
        }
    }
  return result.sort((a, b) =>
    String(a.startAt).localeCompare(String(b.startAt)),
  );
}
export async function snapshotDays(
  db: DB,
  tenant: Tenant,
  staffId: string,
  from: string,
  days = 31,
) {
  let day = DateTime.fromISO(from, { zone: tenant.timezone });
  for (let i = 0; i < days; i++, day = day.plus({ days: 1 })) {
    const intervals = await dayIntervals(db, tenant, staffId, day.toISODate()!);
    await db.query(
      "INSERT INTO schedule_snapshots(tenant_id,staff_id,local_date,intervals,available_minutes,frozen) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(staff_id,local_date) DO UPDATE SET intervals=EXCLUDED.intervals,available_minutes=EXCLUDED.available_minutes,frozen=EXCLUDED.frozen WHERE NOT schedule_snapshots.frozen",
      [
        tenant.id,
        staffId,
        day.toISODate(),
        JSON.stringify(intervals),
        intervals.reduce((n, [s, e]) => n + (e - s) / 60000, 0),
        day.endOf("day").toMillis() < Date.now(),
      ],
    );
  }
}
