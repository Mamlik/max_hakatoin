CREATE TABLE visit_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 booking_id uuid NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users,
 staff_id uuid NOT NULL,
 rating smallint NOT NULL CHECK(rating BETWEEN 1 AND 5),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','invalidated')),
 invalidated_reason text,
 staff_name_snapshot text NOT NULL,
 tenant_name_snapshot text NOT NULL,
 version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 invalidated_at timestamptz,
 FOREIGN KEY(tenant_id,booking_id) REFERENCES bookings(tenant_id,id),
 FOREIGN KEY(tenant_id,staff_id) REFERENCES staff(tenant_id,id),
 CHECK(
   (status='active' AND invalidated_reason IS NULL AND invalidated_at IS NULL) OR
   (status='invalidated' AND invalidated_reason IS NOT NULL AND invalidated_at IS NOT NULL)
 )
);
CREATE INDEX visit_reviews_staff_active ON visit_reviews(tenant_id,staff_id) WHERE status='active';
CREATE INDEX visit_reviews_user_booking ON visit_reviews(user_id,booking_id);
CREATE INDEX visit_reviews_tenant_updated ON visit_reviews(tenant_id,updated_at DESC);
