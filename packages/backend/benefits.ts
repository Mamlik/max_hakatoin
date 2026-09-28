import { fail } from './errors.js';

export type BenefitType = 'fixed' | 'percent' | 'free_visits';

// Prices are integer kopecks. Math.round gives a single consistent half-up rule
// for non-negative prices, and the result is always capped at the service price.
export function benefitDiscount(priceMinor: number, type: BenefitType, fixedMinor?: number | null, percent?: number | null): number {
  if (type === 'free_visits') return priceMinor;
  const amount = type === 'fixed' ? fixedMinor : percent == null ? null : Math.round(priceMinor * percent / 100);
  if (amount == null || !Number.isFinite(amount) || amount <= 0) fail(409, 'BENEFIT_UNAVAILABLE', 'Некорректные условия награды');
  return Math.min(priceMinor, amount);
}
