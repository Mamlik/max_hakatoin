CREATE TABLE map_geocoder_cache (
  provider text NOT NULL CHECK (provider IN ('nominatim','geoapify')),
  query_hash char(64) NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(provider, query_hash)
);
CREATE INDEX map_geocoder_cache_expiry ON map_geocoder_cache(expires_at);

CREATE TABLE map_geocoder_state (
  provider text PRIMARY KEY CHECK (provider IN ('nominatim','geoapify')),
  last_request_at timestamptz NOT NULL DEFAULT '-infinity',
  cache_cleaned_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO map_geocoder_state(provider) VALUES ('nominatim'), ('geoapify');
