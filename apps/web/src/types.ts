export interface User {
  id: string;
  displayName: string;
  partnerProgramEnabled: boolean;
  marketingMessagesEnabled: boolean;
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
  schemaVersion?: 2;
  accent: string;
  description: string;
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  categoryOrder: string[];
  themePreset?: "studio" | "editorial" | "noir";
  colorMode?: "light" | "dark";
  coverFocalPoint?: { x: number; y: number };
  serviceCards?: {
    variant: "compact" | "media";
    showDescription: boolean;
  };
  staffCards?: {
    variant: "compact" | "profile";
    showDescription: boolean;
    showRating: boolean;
  };
  sectionOrder?: Array<"services" | "staff" | "gallery">;
  galleryMediaIds?: string[];
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
  discoveryProfile?: DiscoveryProfile;
  discoveryDraft?: DiscoveryProfile & { geoStatus?: string };
  socialLinks?: SalonSocialLink[];
  location?: { latitude: number; longitude: number; address: string; city: string; district: string; metroStations: string[]; geoStatus: string } | null;
  rating?: { average: number; count: number } | null;
  hours?: { weekday: number; intervals: { start: string; end: string }[] }[];
}
export interface DiscoveryProfile {
  shortDescription: string;
  description: string;
  showMap: boolean;
  showHours: boolean;
  showGallery: boolean;
  showRating: boolean;
  showLinks: boolean;
  address: string;
  city: string;
  district: string;
  metroStations: string[];
  latitude: number | null;
  longitude: number | null;
}
export interface SalonSocialLink {
  id?: string;
  kind: "website" | "max" | "vk" | "telegram" | "instagram" | "tiktok" | "other";
  url: string;
  label: string;
  sortOrder: number;
  validationStatus?: "pending" | "approved" | "rejected";
}
export interface DiscoverySalon {
  id: string;
  publicCode: string;
  name: string;
  category: string;
  address: string;
  shortDescription: string;
  cover: Media | null;
  logo: Media | null;
  minPriceMinor: number | null;
  matchedServices: string[];
  onlineBooking: boolean;
  openNow: boolean;
  distanceKm: number | null;
  favorite: boolean;
  rating: number | null;
  location: { latitude: number; longitude: number } | null;
}
export interface MapCluster {
  longitude: number;
  latitude: number;
  count: number;
  west: number;
  east: number;
  south: number;
  north: number;
}
export interface DiscoveryResponse {
  items: DiscoverySalon[];
  clusters: MapCluster[];
  nextCursor: string | null;
  totalApprox: number;
  appliedFilters: Record<string, unknown>;
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
  ratingAverage?: number | null;
  ratingCount?: number | null;
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
  promotionVersionId?: string | null;
  allowedActions: string[];
  reviewRating?: number | null;
  reviewStatus?: "active" | "invalidated" | null;
  canReview?: boolean;
  review?: VisitReview | null;
  reviewEligibility?: { eligible: boolean; reason: string | null };
  history?: { version: number; reason: string | null; createdAt: string }[];
  deliveries?: { state: string; category: string; lastError: string | null }[];
}
export interface VisitReview {
  id: string;
  rating: number;
  status: "active" | "invalidated";
  version: number;
  staffNameSnapshot: string;
  tenantNameSnapshot: string;
  createdAt: string;
  updatedAt: string;
  invalidatedReason: string | null;
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
  promotionVersionId?: string | null;
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
  discountMinor: number | null;
  rewardType:'fixed'|'percent'|'free_visits';discountPercent:number|null;remainingVisits:number|null;
  reservedVisits:number;
  targetServiceIds: string[];
  termsSnapshot: { termsText: string };
  expiresAt: string | null;
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
  discountMinor: number|null;
  rewardType:'fixed'|'percent'|'free_visits';discountPercent:number|null;freeVisitsCount:number|null;
  issueFrom: string|null;
  issueUntil: string|null;
  voucherValidDays: number|null;
  issueLimit: number|null;
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
export interface WaitlistRequest {
  id: string;
  tenantId: string;
  serviceId: string;
  linkedBookingId: string | null;
  dateFrom: string;
  dateTo: string;
  weekdays: number[];
  dailyStartLocal: string;
  dailyEndLocal: string;
  minimumNoticeMinutes: number;
  priorityAt: string;
  status: string;
  suspensionReason: string | null;
  version: number;
  staffIds: string[];
  offer?: {
    id: string;
    status: string;
    offeredAt: string | null;
    expiresAt: string | null;
    terminalReason: string | null;
    version: number;
  } | null;
}
export interface LiveWindowOffer {
  id: string;
  tenantId: string;
  status: string;
  version: number;
  startAt: string;
  endAt: string;
  expiresAt: string | null;
  tenantName: string;
  serviceName: string;
  staffName: string;
  timezone: string;
  linkedBookingId: string | null;
  requestStatus: string;
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
