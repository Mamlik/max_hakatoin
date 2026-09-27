-- Live Window Lite is additive. Existing booking and delivery semantics remain unchanged.
CREATE TABLE live_window_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 enabled boolean NOT NULL DEFAULT false,
 paused boolean NOT NULL DEFAULT false,
 pause_reason text,
 offer_ttl_minutes int NOT NULL DEFAULT 10 CHECK(offer_ttl_minutes BETWEEN 5 AND 30),
 minimum_notice_minutes int NOT NULL DEFAULT 60 CHECK(minimum_notice_minutes BETWEEN 0 AND 10080),
 quiet_start time NOT NULL DEFAULT '09:00',
 quiet_end time NOT NULL DEFAULT '21:00',
 version int NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE waitlist_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 service_id uuid NOT NULL,
 linked_booking_id uuid,
 linked_booking_version int,
 date_from date NOT NULL,
 date_to date NOT NULL,
 weekdays int[] NOT NULL,
 daily_start_local time NOT NULL,
 daily_end_local time NOT NULL,
 minimum_notice_minutes int NOT NULL CHECK(minimum_notice_minutes BETWEEN 0 AND 10080),
 priority_at timestamptz NOT NULL DEFAULT now(),
 eligibility_hash text NOT NULL,
 consent_version text NOT NULL,
 consented_at timestamptz NOT NULL DEFAULT now(),
 consent_source text NOT NULL DEFAULT 'mini_app',
 revoked_at timestamptz,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','paused_channel_unavailable','fulfilled','cancelled','expired','suspended_incompatible')),
 suspension_reason text,
 version int NOT NULL DEFAULT 1,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CHECK(date_to >= date_from AND date_to <= date_from + 30),
 CHECK(cardinality(weekdays) BETWEEN 1 AND 7),
 CHECK(weekdays <@ ARRAY[1,2,3,4,5,6,7]),
 CHECK(daily_end_local > daily_start_local),
 CHECK((linked_booking_id IS NULL) = (linked_booking_version IS NULL)),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,linked_booking_id) REFERENCES bookings(tenant_id,id)
);
CREATE INDEX waitlist_user ON waitlist_requests(user_id,tenant_id,created_at DESC);
CREATE INDEX waitlist_match ON waitlist_requests(tenant_id,service_id,priority_at,id) WHERE status='active';
CREATE UNIQUE INDEX waitlist_equivalent_active ON waitlist_requests(tenant_id,user_id,eligibility_hash) WHERE status IN ('active','paused','paused_channel_unavailable','suspended_incompatible');
CREATE UNIQUE INDEX waitlist_linked_booking_active ON waitlist_requests(linked_booking_id) WHERE linked_booking_id IS NOT NULL AND status IN ('active','paused','paused_channel_unavailable','suspended_incompatible');

CREATE TABLE waitlist_request_staff (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 staff_id uuid NOT NULL,
 PRIMARY KEY(request_id,staff_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES waitlist_requests(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id)
);

CREATE TABLE domain_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 event_key text NOT NULL UNIQUE,
 event_type text NOT NULL,
 payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','processed','dead')),
 attempts int NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 fence int NOT NULL DEFAULT 0,
 last_error text,
 processed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_outbox_due ON domain_outbox(available_at,created_at) WHERE state IN ('pending','processing');

CREATE TABLE live_windows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 staff_id uuid NOT NULL,
 service_id uuid NOT NULL,
 source_event_key text NOT NULL UNIQUE,
 source_booking_id uuid NOT NULL,
 source_booking_version int NOT NULL,
 start_at timestamptz NOT NULL,
 end_at timestamptz NOT NULL,
 duration_snapshot int NOT NULL CHECK(duration_snapshot BETWEEN 5 AND 480),
 timezone_snapshot text NOT NULL,
 status text NOT NULL DEFAULT 'detected' CHECK(status IN ('detected','matching','offering','filled','exhausted','closed')),
 close_reason text,
 filled_booking_id uuid,
 version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CHECK(end_at > start_at),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,source_booking_id) REFERENCES bookings(tenant_id,id),
 FOREIGN KEY(tenant_id,filled_booking_id) REFERENCES bookings(tenant_id,id)
);
CREATE INDEX live_window_work ON live_windows(tenant_id,status,start_at);

CREATE TABLE live_window_offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 window_id uuid NOT NULL,
 request_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id),
 request_version int NOT NULL,
 eligibility_hash text NOT NULL,
 service_id uuid NOT NULL,
 staff_id uuid NOT NULL,
 visit_start_at timestamptz NOT NULL,
 visit_end_at timestamptz NOT NULL,
 price_minor_snapshot int NOT NULL CHECK(price_minor_snapshot >= 0),
 duration_snapshot int NOT NULL CHECK(duration_snapshot BETWEEN 5 AND 480),
 timezone_snapshot text NOT NULL,
 sequence int NOT NULL CHECK(sequence > 0),
 status text NOT NULL DEFAULT 'pending_delivery' CHECK(status IN ('pending_delivery','offered','accepted','booked','delivery_failed','declined','expired','revoked','lost')),
 offered_at timestamptz,
 expires_at timestamptz,
 terminal_reason text,
 booking_id uuid,
 delivery_dedupe_key text NOT NULL DEFAULT gen_random_uuid()::text,
 version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(window_id,request_id),
 UNIQUE(window_id,sequence),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,window_id) REFERENCES live_windows(tenant_id,id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES waitlist_requests(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id),
 FOREIGN KEY(tenant_id,booking_id) REFERENCES bookings(tenant_id,id)
);
CREATE UNIQUE INDEX live_offer_window_active ON live_window_offers(window_id) WHERE status IN ('pending_delivery','offered','accepted');
CREATE UNIQUE INDEX live_offer_request_active ON live_window_offers(request_id) WHERE status IN ('pending_delivery','offered','accepted');
CREATE UNIQUE INDEX live_offer_user_active ON live_window_offers(user_id) WHERE status IN ('pending_delivery','offered','accepted');
CREATE INDEX live_offer_expiry ON live_window_offers(expires_at) WHERE status='offered';

ALTER TABLE deliveries ADD COLUMN live_window_offer_id uuid REFERENCES live_window_offers(id);
CREATE UNIQUE INDEX delivery_live_window_offer ON deliveries(live_window_offer_id) WHERE live_window_offer_id IS NOT NULL;

INSERT INTO system_state(key,value)
VALUES
 ('live_window_allowlist','{"enabled":true}'::jsonb),
 ('live_window_kill_switch','{"enabled":false}'::jsonb)
ON CONFLICT(key) DO NOTHING;
