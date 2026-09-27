ALTER TABLE services
  ADD COLUMN cover_media_id uuid REFERENCES media_assets(id);

ALTER TABLE media_assets
  DROP CONSTRAINT media_assets_purpose_check;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_purpose_check
  CHECK (purpose IN ('logo','cover','staff','service'));
