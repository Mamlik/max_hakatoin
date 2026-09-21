export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export function fail(status: number, code: string, message: string, details: Record<string, unknown> = {}): never { throw new AppError(status, code, message, details); }
export function required<T>(item: T | undefined | null): T { if (item == null) fail(404, 'NOT_FOUND', 'Объект не найден или недоступен'); return item; }
export function version(item: {version: number}, expected: number | undefined) { if (item.version !== expected) fail(409, 'STALE_VERSION', 'Данные изменились. Обновите страницу и проверьте изменения.'); }
