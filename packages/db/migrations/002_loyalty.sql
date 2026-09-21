CREATE TABLE loyalty_programs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
 service_id uuid NOT NULL, visits_required int NOT NULL CHECK(visits_required BETWEEN 2 AND 50),
 enabled boolean NOT NULL DEFAULT true, version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,service_id), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id)
);
CREATE TABLE loyalty_rewards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, customer_id uuid NOT NULL,
 program_id uuid NOT NULL, service_id uuid NOT NULL, service_name text NOT NULL,
 visits_required int NOT NULL, status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','reserved','redeemed','revoked')),
 reserved_booking_id uuid, redeemed_booking_id uuid, issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
 FOREIGN KEY(tenant_id,program_id) REFERENCES loyalty_programs(tenant_id,id),
 FOREIGN KEY(tenant_id,service_id) REFERENCES services(tenant_id,id),
 FOREIGN KEY(tenant_id,reserved_booking_id) REFERENCES bookings(tenant_id,id),
 FOREIGN KEY(tenant_id,redeemed_booking_id) REFERENCES bookings(tenant_id,id)
);
CREATE TABLE loyalty_stamps (
 booking_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, customer_id uuid NOT NULL, program_id uuid NOT NULL,
 reward_id uuid, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,booking_id) REFERENCES bookings(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
 FOREIGN KEY(tenant_id,program_id) REFERENCES loyalty_programs(tenant_id,id),
 FOREIGN KEY(tenant_id,reward_id) REFERENCES loyalty_rewards(tenant_id,id)
);
CREATE INDEX loyalty_progress ON loyalty_stamps(customer_id,program_id) WHERE active AND reward_id IS NULL;
CREATE INDEX loyalty_customer_rewards ON loyalty_rewards(customer_id,status);
ALTER TABLE bookings ADD COLUMN loyalty_reward_id uuid;
ALTER TABLE bookings ADD FOREIGN KEY(tenant_id,loyalty_reward_id) REFERENCES loyalty_rewards(tenant_id,id);
