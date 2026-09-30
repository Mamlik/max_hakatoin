ALTER TABLE users
  ADD COLUMN service_notifications_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN live_window_notifications_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE notification_exclusions (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('service', 'reminder', 'live_window')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id, category)
);

INSERT INTO notification_exclusions(user_id, tenant_id, category)
SELECT user_id, tenant_id, 'service' FROM preferences WHERE NOT service_bot_enabled
UNION ALL
SELECT user_id, tenant_id, 'reminder' FROM preferences WHERE NOT reminder_bot_enabled
UNION ALL
SELECT user_id, tenant_id, 'live_window' FROM preferences WHERE NOT offer_bot_enabled;
