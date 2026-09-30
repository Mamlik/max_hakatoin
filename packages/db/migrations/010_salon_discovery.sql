CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE salon_discovery_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES tenants ON DELETE CASCADE,
  draft jsonb NOT NULL DEFAULT '{"shortDescription":"","description":"","showMap":false,"showHours":true,"showGallery":true,"showRating":true,"showLinks":true}'::jsonb,
  published jsonb NOT NULL DEFAULT '{"shortDescription":"","description":"","showMap":false,"showHours":true,"showGallery":true,"showRating":true,"showLinks":true}'::jsonb,
  draft_version int NOT NULL DEFAULT 1,
  published_version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE salon_locations (
  tenant_id uuid PRIMARY KEY REFERENCES tenants ON DELETE CASCADE,
  draft_latitude numeric(9,6),
  draft_longitude numeric(9,6),
  draft_address text NOT NULL DEFAULT '',
  draft_city text NOT NULL DEFAULT '',
  draft_district text NOT NULL DEFAULT '',
  draft_metro_stations text[] NOT NULL DEFAULT '{}',
  draft_geo_status text NOT NULL DEFAULT 'draft' CHECK(draft_geo_status IN ('draft','pending','verified','rejected')),
  published_latitude numeric(9,6),
  published_longitude numeric(9,6),
  published_address text NOT NULL DEFAULT '',
  published_city text NOT NULL DEFAULT '',
  published_district text NOT NULL DEFAULT '',
  published_metro_stations text[] NOT NULL DEFAULT '{}',
  published_geo_status text NOT NULL DEFAULT 'draft' CHECK(published_geo_status IN ('draft','pending','verified','rejected')),
  provider_place_id text,
  geocoded_at timestamptz,
  verified_by uuid REFERENCES users,
  verified_at timestamptz,
  draft_point geography(Point,4326) GENERATED ALWAYS AS (
    CASE WHEN draft_latitude IS NOT NULL AND draft_longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(draft_longitude::float8,draft_latitude::float8),4326)::geography
      ELSE NULL END
  ) STORED,
  published_point geography(Point,4326) GENERATED ALWAYS AS (
    CASE WHEN published_latitude IS NOT NULL AND published_longitude IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint(published_longitude::float8,published_latitude::float8),4326)::geography
      ELSE NULL END
  ) STORED,
  CHECK((draft_latitude IS NULL) = (draft_longitude IS NULL)),
  CHECK((published_latitude IS NULL) = (published_longitude IS NULL)),
  CHECK(draft_latitude IS NULL OR draft_latitude BETWEEN -90 AND 90),
  CHECK(draft_longitude IS NULL OR draft_longitude BETWEEN -180 AND 180),
  CHECK(published_latitude IS NULL OR published_latitude BETWEEN -90 AND 90),
  CHECK(published_longitude IS NULL OR published_longitude BETWEEN -180 AND 180),
  CHECK(cardinality(draft_metro_stations) <= 3),
  CHECK(cardinality(published_metro_stations) <= 3)
);
CREATE INDEX salon_locations_published_point ON salon_locations USING gist(published_point)
  WHERE published_geo_status='verified' AND published_point IS NOT NULL;
CREATE INDEX salon_locations_city ON salon_locations(published_city);
CREATE INDEX salon_locations_district ON salon_locations(published_district);
CREATE INDEX salon_locations_metro ON salon_locations USING gin(published_metro_stations);
CREATE INDEX salon_locations_city_search ON salon_locations USING gin (replace(lower(coalesce(published_city,'')),'ё','е') gin_trgm_ops);
CREATE INDEX salon_locations_district_search ON salon_locations USING gin (replace(lower(coalesce(published_district,'')),'ё','е') gin_trgm_ops);
CREATE INDEX tenants_public_name_search ON tenants USING gin (replace(lower(coalesce(published_profile->>'name','')),'ё','е') gin_trgm_ops) WHERE status='published';
CREATE INDEX salons_category_search ON tenants USING gin (replace(lower(coalesce(category,'')),'ё','е') gin_trgm_ops) WHERE status='published';
CREATE INDEX salons_legacy_address_search ON tenants USING gin (replace(lower(coalesce(published_profile->>'address','')),'ё','е') gin_trgm_ops) WHERE status='published';
CREATE INDEX salon_discovery_short_search ON salon_discovery_profiles USING gin (replace(lower(coalesce(published->>'shortDescription','')),'ё','е') gin_trgm_ops);
CREATE INDEX salon_discovery_description_search ON salon_discovery_profiles USING gin (replace(lower(coalesce(published->>'description','')),'ё','е') gin_trgm_ops);
CREATE INDEX services_active_name_search ON services USING gin (replace(lower(coalesce(name,'')),'ё','е') gin_trgm_ops) WHERE active;
CREATE INDEX services_active_tenant_price ON services(tenant_id,price_minor) WHERE active;

CREATE TABLE salon_social_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('website','max','vk','telegram','instagram','tiktok','other')),
  draft_url text,
  draft_label text NOT NULL DEFAULT '',
  draft_sort_order int NOT NULL DEFAULT 0,
  draft_validation_status text NOT NULL DEFAULT 'pending' CHECK(draft_validation_status IN ('pending','approved','rejected')),
  rejection_reason text,
  published_kind text,
  published_url text,
  published_label text,
  published_sort_order int,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
CHECK(length(draft_label)<=40)
);
CREATE INDEX salon_social_links_public ON salon_social_links(tenant_id,published_sort_order)
  WHERE published_url IS NOT NULL;
