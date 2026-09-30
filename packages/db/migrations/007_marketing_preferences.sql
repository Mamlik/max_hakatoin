ALTER TABLE users
  ADD COLUMN marketing_messages_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE marketing_exclusions (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
