ALTER TABLE preferences
  ALTER COLUMN service_bot_enabled SET DEFAULT true,
  ALTER COLUMN reminder_bot_enabled SET DEFAULT true,
  ALTER COLUMN offer_bot_enabled SET DEFAULT true;
