ALTER TABLE loyalty_programs DROP CONSTRAINT loyalty_programs_tenant_id_service_id_key;
ALTER TABLE loyalty_programs ADD COLUMN name text NOT NULL DEFAULT 'Бесплатное посещение';
ALTER TABLE loyalty_programs ADD COLUMN reward_type text NOT NULL DEFAULT 'free_visits' CHECK (reward_type IN ('fixed','percent','free_visits'));
ALTER TABLE loyalty_programs ADD COLUMN fixed_discount_minor int;
ALTER TABLE loyalty_programs ADD COLUMN discount_percent int;
ALTER TABLE loyalty_programs ADD COLUMN free_visits_count int NOT NULL DEFAULT 1;
ALTER TABLE loyalty_programs ALTER COLUMN free_visits_count DROP NOT NULL;
ALTER TABLE loyalty_programs ALTER COLUMN free_visits_count DROP DEFAULT;
ALTER TABLE loyalty_programs ADD COLUMN starts_at timestamptz;
ALTER TABLE loyalty_programs ADD COLUMN ends_at timestamptz;
ALTER TABLE loyalty_programs ADD COLUMN reward_valid_days int;
ALTER TABLE loyalty_programs ADD COLUMN issue_limit int;
ALTER TABLE loyalty_programs ADD COLUMN issued_total int NOT NULL DEFAULT 0;
UPDATE loyalty_programs p SET issued_total=(SELECT count(*) FROM loyalty_rewards r WHERE r.program_id=p.id);
ALTER TABLE loyalty_programs ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','exhausted','ended'));
ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_program_terms CHECK (
  (reward_type='fixed' AND fixed_discount_minor>0 AND discount_percent IS NULL AND free_visits_count IS NULL) OR
  (reward_type='percent' AND discount_percent BETWEEN 1 AND 100 AND fixed_discount_minor IS NULL AND free_visits_count IS NULL) OR
  (reward_type='free_visits' AND free_visits_count BETWEEN 1 AND 50 AND fixed_discount_minor IS NULL AND discount_percent IS NULL));
ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_program_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at>starts_at);
ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_program_limits CHECK (reward_valid_days IS NULL OR reward_valid_days BETWEEN 1 AND 365);
ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_program_issue_limit CHECK (issue_limit IS NULL OR issue_limit>0);
CREATE INDEX loyalty_program_service ON loyalty_programs(tenant_id,service_id,status);

ALTER TABLE loyalty_stamps DROP CONSTRAINT loyalty_stamps_pkey;
ALTER TABLE loyalty_stamps ADD PRIMARY KEY(booking_id,program_id);
ALTER TABLE loyalty_rewards ADD COLUMN reward_type text NOT NULL DEFAULT 'free_visits' CHECK(reward_type IN ('fixed','percent','free_visits'));
ALTER TABLE loyalty_rewards ADD COLUMN fixed_discount_minor int;
ALTER TABLE loyalty_rewards ADD COLUMN discount_percent int;
ALTER TABLE loyalty_rewards ADD COLUMN free_visits_count int NOT NULL DEFAULT 1;
ALTER TABLE loyalty_rewards ALTER COLUMN free_visits_count DROP NOT NULL;
ALTER TABLE loyalty_rewards ALTER COLUMN free_visits_count DROP DEFAULT;
ALTER TABLE loyalty_rewards ADD COLUMN remaining_visits int NOT NULL DEFAULT 1;
ALTER TABLE loyalty_rewards ADD COLUMN expires_at timestamptz;
ALTER TABLE loyalty_rewards ADD COLUMN terms_snapshot jsonb NOT NULL DEFAULT '{}';
UPDATE loyalty_rewards SET remaining_visits=0 WHERE status='redeemed';
UPDATE loyalty_rewards SET terms_snapshot=jsonb_build_object('visitsRequired',visits_required,'rewardType','free_visits','freeVisitsCount',1,'rewardValidDays',NULL)
WHERE terms_snapshot='{}'::jsonb;
ALTER TABLE loyalty_rewards DROP CONSTRAINT loyalty_rewards_status_check;
ALTER TABLE loyalty_rewards ADD CONSTRAINT loyalty_rewards_status_check CHECK(status IN ('issued','reserved','redeemed','revoked','expired'));
ALTER TABLE loyalty_rewards ADD CONSTRAINT loyalty_reward_visits CHECK (remaining_visits BETWEEN 0 AND free_visits_count);
ALTER TABLE loyalty_rewards ADD CONSTRAINT loyalty_reward_terms CHECK (
  (reward_type='fixed' AND fixed_discount_minor>0 AND discount_percent IS NULL AND free_visits_count IS NULL AND remaining_visits=0) OR
  (reward_type='percent' AND discount_percent BETWEEN 1 AND 100 AND fixed_discount_minor IS NULL AND free_visits_count IS NULL AND remaining_visits=0) OR
  (reward_type='free_visits' AND free_visits_count BETWEEN 1 AND 50 AND fixed_discount_minor IS NULL AND discount_percent IS NULL));
CREATE TABLE loyalty_reward_uses (
  reward_id uuid NOT NULL REFERENCES loyalty_rewards, booking_id uuid NOT NULL REFERENCES bookings,
  status text NOT NULL CHECK(status IN ('reserved','redeemed','released')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(reward_id,booking_id), UNIQUE(booking_id)
);

ALTER TABLE campaign_versions DROP CONSTRAINT campaign_versions_discount_minor_check;
ALTER TABLE campaign_versions DROP CONSTRAINT campaign_versions_check;
ALTER TABLE campaign_versions ALTER COLUMN discount_minor DROP NOT NULL;
ALTER TABLE campaign_versions ALTER COLUMN issue_from DROP NOT NULL;
ALTER TABLE campaign_versions ALTER COLUMN issue_until DROP NOT NULL;
ALTER TABLE campaign_versions ALTER COLUMN issue_limit DROP NOT NULL;
ALTER TABLE campaign_versions ALTER COLUMN voucher_valid_days DROP NOT NULL;
ALTER TABLE campaign_versions ADD COLUMN reward_type text NOT NULL DEFAULT 'fixed' CHECK(reward_type IN ('fixed','percent','free_visits'));
ALTER TABLE campaign_versions ADD COLUMN discount_percent int;
ALTER TABLE campaign_versions ADD COLUMN free_visits_count int;
ALTER TABLE campaign_versions ADD CONSTRAINT campaign_reward_terms CHECK (
  (reward_type='fixed' AND discount_minor>0 AND discount_percent IS NULL AND free_visits_count IS NULL) OR
  (reward_type='percent' AND discount_percent BETWEEN 1 AND 100 AND discount_minor IS NULL AND free_visits_count IS NULL) OR
  (reward_type='free_visits' AND free_visits_count BETWEEN 1 AND 50 AND discount_minor IS NULL AND discount_percent IS NULL));
ALTER TABLE campaign_versions ADD CONSTRAINT campaign_issue_window CHECK(issue_until IS NULL OR issue_from IS NULL OR issue_until>issue_from);
ALTER TABLE campaign_versions ADD CONSTRAINT campaign_issue_limit CHECK(issue_limit IS NULL OR issue_limit>0);
ALTER TABLE vouchers ADD COLUMN reward_type text NOT NULL DEFAULT 'fixed';
ALTER TABLE vouchers ADD COLUMN discount_percent int;
ALTER TABLE vouchers ADD COLUMN free_visits_count int;
ALTER TABLE vouchers ADD COLUMN remaining_visits int;
ALTER TABLE vouchers ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE vouchers ALTER COLUMN discount_minor DROP NOT NULL;
ALTER TABLE vouchers ADD CONSTRAINT voucher_reward_terms CHECK (
  (reward_type='fixed' AND discount_minor>0 AND discount_percent IS NULL AND free_visits_count IS NULL AND remaining_visits IS NULL) OR
  (reward_type='percent' AND discount_percent BETWEEN 1 AND 100 AND discount_minor IS NULL AND free_visits_count IS NULL AND remaining_visits IS NULL) OR
  (reward_type='free_visits' AND free_visits_count BETWEEN 1 AND 50 AND remaining_visits BETWEEN 0 AND free_visits_count AND discount_minor IS NULL AND discount_percent IS NULL));
CREATE TABLE voucher_uses (
  voucher_id uuid NOT NULL REFERENCES vouchers, booking_id uuid NOT NULL REFERENCES bookings,
  status text NOT NULL CHECK(status IN ('reserved','redeemed','released')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(voucher_id,booking_id), UNIQUE(booking_id)
);
CREATE TABLE campaign_customer_consents (
  user_id uuid NOT NULL REFERENCES users, version_id uuid NOT NULL REFERENCES campaign_versions,
  granted boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,version_id)
);

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_tenant_id uuid NOT NULL REFERENCES tenants,
  proposer_tenant_id uuid NOT NULL REFERENCES tenants, status text NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','proposed','active','rejected','ended')),
  active_version_id uuid, pending_version_id uuid, version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE promotion_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), promotion_id uuid NOT NULL REFERENCES promotions,
  number int NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','proposed','active','rejected','ended')), title text NOT NULL, terms_text text NOT NULL,
  service_ids uuid[] NOT NULL, discount_type text NOT NULL CHECK(discount_type IN ('fixed','percent')),
  fixed_discount_minor int, discount_percent int, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  use_limit int, terms_hash text NOT NULL, used_total int NOT NULL DEFAULT 0, version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(promotion_id,number),
  CHECK(ends_at>starts_at), CHECK(use_limit IS NULL OR use_limit>0),
  CHECK((discount_type='fixed' AND fixed_discount_minor>0 AND discount_percent IS NULL) OR
        (discount_type='percent' AND discount_percent BETWEEN 1 AND 100 AND fixed_discount_minor IS NULL))
);
ALTER TABLE promotions ADD FOREIGN KEY(active_version_id) REFERENCES promotion_versions;
ALTER TABLE promotions ADD FOREIGN KEY(pending_version_id) REFERENCES promotion_versions;
CREATE TABLE promotion_acceptances (
  version_id uuid NOT NULL REFERENCES promotion_versions, tenant_id uuid NOT NULL REFERENCES tenants,
  user_id uuid NOT NULL REFERENCES users, terms_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(version_id,tenant_id)
);
CREATE TABLE promotion_pauses (
  promotion_id uuid NOT NULL REFERENCES promotions, tenant_id uuid NOT NULL REFERENCES tenants,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(promotion_id,tenant_id)
);
CREATE TABLE promotion_reservations (
  booking_id uuid PRIMARY KEY REFERENCES bookings, version_id uuid NOT NULL REFERENCES promotion_versions,
  status text NOT NULL CHECK(status IN ('reserved','used','released')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bookings ADD COLUMN promotion_version_id uuid REFERENCES promotion_versions;
