import { z } from "zod";
export const id = z.uuid();
export const text = z.string().trim().min(1).max(120);
export const reason = z.string().trim().min(3).max(1000);
export const expected = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const command = expected.extend({ reason: reason.optional() }).strict();
export const empty = z.object({}).strict();
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const instant = z.iso.datetime({ offset: true });
export const profile = z
  .object({
    name: text,
    category: text,
    address: z.string().trim().min(3).max(300),
    contact: z.string().trim().min(3).max(200),
    timezone: z.string().max(80),
  })
  .strict();
export const style = z
  .object({
    accent: z.enum(["violet", "rose", "teal", "amber"]),
    description: z.string().max(2000),
    logoMediaId: id.nullable().optional(),
    coverMediaId: id.nullable().optional(),
    categoryOrder: z.array(id).max(100),
  })
  .strict();
export const service = z
  .object({
    name: text,
    description: z.string().max(2000).default(""),
    categoryId: id.nullable().optional(),
    durationMin: z.number().int().min(5).max(480),
    priceMinor: z.number().int().min(0).max(100000000),
    active: z.boolean().default(true),
  })
  .strict();
export const staff = z
  .object({
    name: text,
    description: z.string().max(2000).default(""),
    active: z.boolean().default(true),
  })
  .strict();
export const interval = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    kind: z.enum(["work", "break"]),
  })
  .strict();
export const schedule = expected
  .extend({
    effectiveFrom: date,
    weekly: z
      .array(
        z
          .object({
            weekday: z.number().int().min(1).max(7),
            intervals: z.array(interval).max(16),
          })
          .strict(),
      )
      .max(7),
    confirmConflicts: z.boolean().default(false),
  })
  .strict();
export const customer = z
  .object({
    displayName: text,
    contact: z.string().max(200).default(""),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  })
  .strict();
export const quote = z
  .object({
    serviceId: id,
    staffId: id,
    startAt: instant,
    voucherId: id.nullable().optional(),
    loyaltyRewardId: id.nullable().optional(),
    customerId: id.optional(),
    expectedVersion: z.number().int().positive().optional(),
    removeVoucher: z.boolean().optional(),
  })
  .strict();
export const book = z
  .object({
    quoteId: id,
    expectedVersion: z.number().int().positive().optional(),
    confirmedTermsVersion: z.literal("booking-p0-v1"),
    overlapChallengeToken: z.string().max(500).nullable().optional(),
    confirmOverlap: z.boolean().optional(),
    removeVoucher: z.boolean().optional(),
  })
  .strict();
export const campaignTerms = z
  .object({
    sourceServiceIds: z.array(id).min(1).max(100),
    targetServiceIds: z.array(id).min(1).max(100),
    discountMinor: z.number().int().positive().max(100000000),
    issueFrom: instant,
    issueUntil: instant,
    voucherValidDays: z.number().int().min(1).max(365),
    issueLimit: z.number().int().min(1).max(1000000),
    termsText: z.string().trim().min(3).max(3000),
  })
  .strict();
