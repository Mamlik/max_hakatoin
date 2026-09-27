export interface User {
  id: string;
  displayName: string;
  partnerProgramEnabled: boolean;
  version: number;
}
export interface Membership {
  id: string;
  tenantId: string;
  userId: string;
  role: "owner" | "admin" | "master";
  status: string;
  tenantName: string;
  displayName: string;
  publicCode: string;
  version: number;
  notificationsEnabled: boolean;
}
export interface Me {
  user: User;
  memberships: Membership[];
  channel: { state: string };
}
export interface Style {
  accent: string;
  description: string;
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  categoryOrder: string[];
}
export interface Media {
  id: string;
  fileKey: string;
  purpose: string;
}
export interface Salon {
  id: string;
  publicCode: string;
  name: string;
  category: string;
  address: string;
  contact: string;
  timezone: string;
  status?: string;
  style: Style;
  draftStyle: Style;
  publishedStyle: Style;
  media: Media[];
  version: number;
  partnerEnabled: boolean;
  favorite?: boolean;
}
export interface Service {
  id: string;
  categoryId: string | null;
  name: string;
  description: string;
  durationMin: number;
  priceMinor: number;
  coverMediaId: string | null;
  active: boolean;
  version: number;
}
export interface Staff {
  id: string;
  name: string;
  description: string;
  active: boolean;
  version: number;
  serviceIds: string[];
  membershipId: string | null;
  photoMediaId: string | null;
}
export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
  version: number;
}
export interface Catalog {
  services: Service[];
  staff: Staff[];
  categories: Category[];
}
export interface Booking {
  id: string;
  tenantId: string;
  tenantName: string;
  publicCode: string;
  customerId: string;
  customerName: string;
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceNameSnapshot: string;
  startAt: string;
  endAt: string;
  timezoneSnapshot: string;
  status: string;
  version: number;
  priceMinorSnapshot?: number;
  discountMinor?: number;
  totalMinor?: number;
  appliedVoucherId?: string | null;
  loyaltyRewardId?: string | null;
  allowedActions: string[];
  history?: { version: number; reason: string | null; createdAt: string }[];
  deliveries?: { state: string; category: string; lastError: string | null }[];
}
export interface Slot {
  staffId: string;
  staffName: string;
  startAt: string;
  endAt: string;
  priceMinor: number;
  timezone: string;
}
export interface Quote {
  id: string;
  expiresAt: string;
  serviceId: string;
  staffId: string;
  staffName: string;
  serviceName: string;
  tenantName: string;
  address: string;
  startAt: string;
  endAt: string;
  priceMinor: number;
  discountMinor: number;
  totalMinor: number;
  durationMin: number;
  removeVoucher?: boolean;
  loyaltyRewardId?: string | null;
}
export interface Customer {
  id: string;
  userId: string | null;
  displayName: string;
  contact: string;
  tags: string[];
  version: number;
  completedVisits: number;
  firstVisit: string;
  lastVisit: string;
  notes: {
    id: string;
    body: string;
    authorName: string;
    createdAt: string;
    version: number;
  }[];
  bookings: Booking[];
  linkInvites: {
    id: string;
    status: string;
    version: number;
    candidateName: string;
    expiresAt: string;
  }[];
}
export interface Preference {
  version: number;
  partnerAllowed: boolean;
  serviceBotEnabled: boolean;
  reminderBotEnabled: boolean;
  offerBotEnabled: boolean;
}
export interface Voucher {
  id: string;
  campaignId: string;
  targetTenantId: string;
  sourceTenantId: string;
  targetName: string;
  sourceName: string;
  targetCode: string;
  status: string;
  discountMinor: number;
  targetServiceIds: string[];
  termsSnapshot: { termsText: string };
  expiresAt: string;
  issuedAt: string;
  version: number;
}
export interface Revocation {
  id: string;
  reason: string;
  version: number;
  bookingVersion: number;
  oldTotalMinor: number;
  newTotalMinor: number;
}
export interface CampaignVersion {
  id: string;
  number: number;
  status: string;
  sourceServiceIds: string[];
  targetServiceIds: string[];
  discountMinor: number;
  issueFrom: string;
  issueUntil: string;
  voucherValidDays: number;
  issueLimit: number;
  termsText: string;
  termsHash: string;
  proposedByTenantId: string | null;
  version: number;
  acceptances: { tenantId: string; acceptedAt: string }[];
}
export interface Campaign {
  id: string;
  sourceTenantId: string;
  targetTenantId: string;
  sourceName: string;
  targetName: string;
  status: string;
  version: number;
  issuedTotal: number;
  activeVersionId: string | null;
  pendingVersionId: string | null;
  versions: CampaignVersion[];
  pauses: { tenantId: string; tenantName: string; reason: string }[];
}
export interface Items<T> {
  items: T[];
  nextCursor: string | null;
}
export interface Interval {
  start: string;
  end: string;
  kind: "work" | "break";
}
export interface Weekday {
  weekday: number;
  intervals: Interval[];
}
export interface Schedule {
  staff: Staff;
  rules: { effectiveFrom: string; weekly: Weekday[]; version: number }[];
  exceptions: { date: string; mode: string; intervals: Interval[] }[];
}
export interface Event {
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  kind: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  objectId: string | null;
}
