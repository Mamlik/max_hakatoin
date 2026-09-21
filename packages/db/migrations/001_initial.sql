CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), max_user_id bigint UNIQUE NOT NULL,
 display_name text NOT NULL, partner_program_enabled boolean NOT NULL DEFAULT false,
 version int NOT NULL DEFAULT 1, is_test boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), public_code text UNIQUE NOT NULL, name text NOT NULL, category text NOT NULL,
 address text NOT NULL, timezone text NOT NULL DEFAULT 'Europe/Moscow', contact text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused','archived')),
 partner_enabled boolean NOT NULL DEFAULT false, operational_recipient_id uuid REFERENCES users,
 draft_style jsonb NOT NULL DEFAULT '{"accent":"violet","description":"","categoryOrder":[]}', published_style jsonb,
 published_profile jsonb, version int NOT NULL DEFAULT 1, is_test boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, user_id uuid NOT NULL REFERENCES users,
 role text NOT NULL CHECK(role IN ('owner','admin','master')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 notifications_enabled boolean NOT NULL DEFAULT false, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,user_id), UNIQUE(tenant_id,id)
);
CREATE TABLE preferences (user_id uuid REFERENCES users, tenant_id uuid REFERENCES tenants, partner_allowed boolean NOT NULL DEFAULT false, service_bot_enabled boolean NOT NULL DEFAULT false, reminder_bot_enabled boolean NOT NULL DEFAULT false, offer_bot_enabled boolean NOT NULL DEFAULT false, version int NOT NULL DEFAULT 1, PRIMARY KEY(user_id,tenant_id));
CREATE TABLE favorites (user_id uuid REFERENCES users, tenant_id uuid REFERENCES tenants, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,tenant_id));
CREATE TABLE bot_channels (user_id uuid PRIMARY KEY REFERENCES users, state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','active','stopped','removed')), event_timestamp bigint NOT NULL DEFAULT 0, event_rank int NOT NULL DEFAULT 0, generation int NOT NULL DEFAULT 0);
CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, name text NOT NULL, sort_order int NOT NULL DEFAULT 0, archived boolean NOT NULL DEFAULT false, version int NOT NULL DEFAULT 1, UNIQUE(tenant_id,id));
CREATE TABLE services (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, category_id uuid,
 name text NOT NULL, description text NOT NULL DEFAULT '', duration_min int NOT NULL CHECK(duration_min BETWEEN 5 AND 480),
 price_minor int NOT NULL CHECK(price_minor BETWEEN 0 AND 100000000), active boolean NOT NULL DEFAULT true,
 version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,category_id) REFERENCES categories(tenant_id,id)
);
CREATE TABLE staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, name text NOT NULL, description text NOT NULL DEFAULT '',
 membership_id uuid, photo_media_id uuid, active boolean NOT NULL DEFAULT true, version int NOT NULL DEFAULT 1,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships(tenant_id,id)
);
CREATE TABLE staff_services (tenant_id uuid NOT NULL, staff_id uuid NOT NULL, service_id uuid NOT NULL, PRIMARY KEY(tenant_id,staff_id,service_id), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id), FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id));
CREATE TABLE schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, staff_id uuid NOT NULL, effective_from date NOT NULL, weekly jsonb NOT NULL, version int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(staff_id,version), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id));
CREATE TABLE schedule_exceptions (tenant_id uuid NOT NULL, staff_id uuid NOT NULL, local_date date NOT NULL, mode text NOT NULL CHECK(mode IN ('closed','replace')), intervals jsonb NOT NULL DEFAULT '[]', version int NOT NULL DEFAULT 1, PRIMARY KEY(staff_id,local_date), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id));
CREATE TABLE schedule_snapshots (tenant_id uuid NOT NULL, staff_id uuid NOT NULL, local_date date NOT NULL, intervals jsonb NOT NULL, available_minutes int NOT NULL, frozen boolean NOT NULL DEFAULT false, PRIMARY KEY(staff_id,local_date), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id));
CREATE TABLE customers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, user_id uuid REFERENCES users,
 display_name text NOT NULL, contact text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}', version int NOT NULL DEFAULT 1,
 is_test boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX customers_user ON customers(tenant_id,user_id) WHERE user_id IS NOT NULL;
CREATE INDEX customers_search ON customers USING gin(display_name gin_trgm_ops);
CREATE TABLE customer_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, customer_id uuid NOT NULL, body text NOT NULL, author_id uuid NOT NULL REFERENCES users, version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id));
CREATE TABLE invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, kind text NOT NULL CHECK(kind IN ('staff','customer')),
 role text CHECK(role IN ('admin','master')), staff_id uuid, customer_id uuid, expected_user_id uuid REFERENCES users,
 token_hash text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'pending', candidate_user_id uuid REFERENCES users,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', version int NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_tenant_id uuid NOT NULL REFERENCES tenants, target_tenant_id uuid NOT NULL REFERENCES tenants,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','proposed','active','rejected','ended')),
 active_version_id uuid, pending_version_id uuid, issued_total int NOT NULL DEFAULT 0, version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(source_tenant_id <> target_tenant_id)
);
CREATE TABLE campaign_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES campaigns, number int NOT NULL,
 status text NOT NULL DEFAULT 'draft', source_service_ids uuid[] NOT NULL, target_service_ids uuid[] NOT NULL,
 discount_minor int NOT NULL CHECK(discount_minor>0), issue_from timestamptz NOT NULL, issue_until timestamptz NOT NULL,
 voucher_valid_days int NOT NULL CHECK(voucher_valid_days BETWEEN 1 AND 365), issue_limit int NOT NULL CHECK(issue_limit>0),
 terms_text text NOT NULL, terms_hash text NOT NULL, proposed_by_tenant_id uuid REFERENCES tenants, version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,number), CHECK(issue_until>issue_from)
);
ALTER TABLE campaigns ADD FOREIGN KEY(active_version_id) REFERENCES campaign_versions;
ALTER TABLE campaigns ADD FOREIGN KEY(pending_version_id) REFERENCES campaign_versions;
CREATE TABLE campaign_acceptances (version_id uuid REFERENCES campaign_versions, tenant_id uuid REFERENCES tenants, user_id uuid REFERENCES users, terms_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version_id,tenant_id));
CREATE TABLE campaign_pauses (campaign_id uuid REFERENCES campaigns, tenant_id uuid REFERENCES tenants, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(campaign_id,tenant_id));
CREATE TABLE bookings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, customer_id uuid NOT NULL, user_id uuid REFERENCES users,
 staff_id uuid NOT NULL, service_id uuid NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
 timezone_snapshot text NOT NULL, status text NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','completed','cancelled','no_show')),
 version int NOT NULL DEFAULT 1, source text NOT NULL CHECK(source IN ('self','manual')), service_name_snapshot text NOT NULL,
 duration_snapshot int NOT NULL, price_minor_snapshot int NOT NULL, discount_minor int NOT NULL DEFAULT 0,
 applied_voucher_id uuid, previous_voucher_id uuid, created_by uuid NOT NULL REFERENCES users, outcome_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), CHECK(end_at>start_at),
 CHECK(price_minor_snapshot>=0 AND discount_minor>=0 AND discount_minor<=price_minor_snapshot),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id), FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id), FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, tstzrange(start_at,end_at,'[)') WITH &&) WHERE(status IN ('confirmed','completed','no_show'))
);
CREATE INDEX booking_calendar ON bookings(tenant_id,start_at,staff_id);
CREATE INDEX booking_user ON bookings(user_id,start_at);
CREATE INDEX booking_customer ON bookings(tenant_id,customer_id,start_at);
CREATE UNIQUE INDEX booking_voucher ON bookings(applied_voucher_id) WHERE applied_voucher_id IS NOT NULL;
CREATE TABLE booking_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, booking_id uuid NOT NULL, version int NOT NULL, actor_id uuid NOT NULL REFERENCES users, reason text, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(booking_id,version), FOREIGN KEY(tenant_id,booking_id) REFERENCES bookings(tenant_id,id));
CREATE TABLE vouchers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES campaigns, version_id uuid NOT NULL REFERENCES campaign_versions,
 source_booking_id uuid NOT NULL REFERENCES bookings, user_id uuid NOT NULL REFERENCES users, source_tenant_id uuid NOT NULL REFERENCES tenants,
 target_tenant_id uuid NOT NULL REFERENCES tenants, status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','reserved','redeemed','expired','revoked')),
 discount_minor int NOT NULL, target_service_ids uuid[] NOT NULL, terms_snapshot jsonb NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, reserved_booking_id uuid REFERENCES bookings,
 redeemed_booking_id uuid REFERENCES bookings, version int NOT NULL DEFAULT 1, UNIQUE(user_id,source_booking_id,campaign_id)
);
ALTER TABLE bookings ADD FOREIGN KEY(applied_voucher_id) REFERENCES vouchers;
ALTER TABLE bookings ADD FOREIGN KEY(previous_voucher_id) REFERENCES vouchers;
CREATE TABLE voucher_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES vouchers, action text NOT NULL, actor_id uuid REFERENCES users, reason text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE partner_exceptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES vouchers, reason text NOT NULL, resolution text, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE revocation_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), voucher_id uuid NOT NULL REFERENCES vouchers, booking_id uuid NOT NULL REFERENCES bookings, reason text NOT NULL, booking_version int NOT NULL, status text NOT NULL DEFAULT 'pending', version int NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users, tenant_id uuid NOT NULL REFERENCES tenants, intent jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE operations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES users, scope text NOT NULL, operation text NOT NULL, key uuid NOT NULL, fingerprint text NOT NULL, status_code int NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,scope,operation,key));
CREATE TABLE audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid REFERENCES tenants, actor_id uuid REFERENCES users, action text NOT NULL, object_id uuid, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_tenant ON audit_log(tenant_id,created_at DESC,id);
CREATE TABLE consent_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, tenant_id uuid REFERENCES tenants, before_state jsonb, after_state jsonb NOT NULL, text_version text NOT NULL DEFAULT 'p0-v1', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users, tenant_id uuid REFERENCES tenants, kind text NOT NULL, object_id uuid, title text NOT NULL, body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX notification_user ON notifications(user_id,created_at DESC,id);
CREATE TABLE deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid NOT NULL REFERENCES notifications, user_id uuid NOT NULL REFERENCES users,
 tenant_id uuid REFERENCES tenants, booking_id uuid REFERENCES bookings, booking_version int, category text NOT NULL,
 membership_id uuid REFERENCES memberships, generation int NOT NULL, state text NOT NULL DEFAULT 'scheduled',
 due_at timestamptz NOT NULL DEFAULT now(), not_after timestamptz NOT NULL, attempts int NOT NULL DEFAULT 0,
 lease_until timestamptz, fence int NOT NULL DEFAULT 0, last_error text, sent_at timestamptz, max_message_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_due ON deliveries(due_at) WHERE state IN ('scheduled','retry_wait');
CREATE TABLE delivery_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES deliveries, attempt int NOT NULL, result text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES deliveries, published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE max_inbox (event_key text PRIMARY KEY, payload jsonb NOT NULL, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE media_assets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants, purpose text NOT NULL CHECK(purpose IN ('logo','cover','staff')), file_key text UNIQUE NOT NULL, published boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE system_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
