export type Role = "owner" | "admin" | "master";
export interface Actor {
  id: string;
  display_name: string;
  max_user_id: string;
  partner_program_enabled: boolean;
  version: number;
  session_id: string;
}
export interface Membership {
  id: string;
  tenant_id: string;
  user_id: string;
  role: Role;
  status: string;
  version: number;
  notifications_enabled: boolean;
}
export interface Tenant {
  id: string;
  public_code: string;
  name: string;
  category: string;
  address: string;
  contact: string;
  timezone: string;
  status: string;
  partner_enabled: boolean;
  operational_recipient_id: string;
  draft_style: Style;
  published_style: Style;
  published_profile: Record<string, string>;
  version: number;
}
export interface Style {
  accent: string;
  description: string;
  logoMediaId?: string | null;
  coverMediaId?: string | null;
  categoryOrder: string[];
}
export interface Service {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  price_minor: number;
  duration_min: number;
  version: number;
  active: boolean;
  category_id: string | null;
  cover_media_id: string | null;
}
export interface Staff {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  active: boolean;
  version: number;
  membership_id: string | null;
  photo_media_id: string | null;
  service_ids?: string[];
  rating_average?: number | null;
  rating_count?: number | null;
}
export interface Customer {
  id: string;
  tenant_id: string;
  user_id: string | null;
  display_name: string;
  contact: string;
  tags: string[];
  version: number;
}
export interface Booking {
  id: string;
  tenant_id: string;
  customer_id: string;
  user_id: string | null;
  staff_id: string;
  service_id: string;
  start_at: Date;
  end_at: Date;
  status: string;
  version: number;
  service_name_snapshot: string;
  duration_snapshot: number;
  price_minor_snapshot: number;
  discount_minor: number;
  applied_voucher_id: string | null;
  previous_voucher_id: string | null;
  loyalty_reward_id: string | null;
  timezone_snapshot: string;
  customer_name?: string;
  staff_name?: string;
  tenant_name?: string;
}
export interface VisitReview {
  id: string;
  tenant_id: string;
  booking_id: string;
  user_id: string;
  staff_id: string;
  rating: number;
  status: "active" | "invalidated";
  invalidated_reason: string | null;
  staff_name_snapshot: string;
  tenant_name_snapshot: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  invalidated_at: Date | null;
}
export interface Voucher {
  id: string;
  campaign_id: string;
  version_id: string;
  source_booking_id: string;
  user_id: string;
  source_tenant_id: string;
  target_tenant_id: string;
  status: string;
  discount_minor: number;
  target_service_ids: string[];
  terms_snapshot: Record<string, unknown>;
  issued_at: Date;
  expires_at: Date;
  reserved_booking_id: string | null;
  redeemed_booking_id: string | null;
  version: number;
}
export interface Campaign {
  id: string;
  source_tenant_id: string;
  target_tenant_id: string;
  status: string;
  active_version_id: string | null;
  pending_version_id: string | null;
  issued_total: number;
  version: number;
}
export interface CampaignVersion {
  id: string;
  campaign_id: string;
  number: number;
  status: string;
  source_service_ids: string[];
  target_service_ids: string[];
  discount_minor: number;
  issue_from: Date;
  issue_until: Date;
  voucher_valid_days: number;
  issue_limit: number;
  terms_text: string;
  terms_hash: string;
  proposed_by_tenant_id: string | null;
  version: number;
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
export interface QuoteIntent {
  serviceId: string;
  staffId: string;
  startAt: string;
  endAt: string;
  customerId: string;
  userId: string | null;
  serviceVersion: number;
  staffVersion: number;
  priceMinor: number;
  durationMin: number;
  discountMinor: number;
  voucherId: string | null;
  loyaltyRewardId?: string | null;
  serviceName: string;
  bookingId?: string;
  expectedVersion?: number;
  removeVoucher?: boolean;
}
export interface WaitlistRequest {
  id: string;
  tenant_id: string;
  user_id: string;
  service_id: string;
  linked_booking_id: string | null;
  linked_booking_version: number | null;
  date_from: string;
  date_to: string;
  weekdays: number[];
  daily_start_local: string;
  daily_end_local: string;
  minimum_notice_minutes: number;
  priority_at: Date;
  eligibility_hash: string;
  consent_version: string;
  status: string;
  suspension_reason: string | null;
  version: number;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  staff_ids?: string[];
}
export interface LiveWindow {
  id: string;
  tenant_id: string;
  staff_id: string;
  service_id: string;
  source_event_key: string;
  source_booking_id: string;
  source_booking_version: number;
  start_at: Date;
  end_at: Date;
  duration_snapshot: number;
  timezone_snapshot: string;
  status: string;
  close_reason: string | null;
  filled_booking_id: string | null;
  version: number;
}
export interface LiveWindowOffer {
  id: string;
  tenant_id: string;
  window_id: string;
  request_id: string;
  user_id: string;
  request_version: number;
  eligibility_hash: string;
  sequence: number;
  status: string;
  offered_at: Date | null;
  expires_at: Date | null;
  terminal_reason: string | null;
  booking_id: string | null;
  version: number;
}
