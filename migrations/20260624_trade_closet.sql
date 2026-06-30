-- Trade-closet feature: location-based in-person trading.
--
-- Adds (a) location columns + coarsened lat/lng to users, (b) the
-- closet_items table for user-posted trade inventory, and (c) the
-- PostGIS extension for radius queries.
--
-- Privacy invariant: users.lat / users.lng are ALWAYS the centroid of
-- the user's stored zip — never a raw GPS coordinate. The Express
-- backend reverse-resolves any GPS input to its containing zip and
-- writes the centroid. Discover never returns another user's exact
-- coordinates — only city/state and rounded distance.
--
-- All tables ENABLE ROW LEVEL SECURITY with NO public policies. Access
-- is through the Express backend using the Supabase service role; all
-- gating lives in middleware (matches the pattern from
-- 20260502_moderation.sql).
--
-- Run this from the Supabase SQL Editor. After running:
--   NOTIFY pgrst, 'reload schema';
-- so PostgREST picks up the new columns and table.

-- ──────────────────────────────────────────────────────────────────────
-- 1. PostGIS — radius search via geography(Point, 4326) + GIST index.
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Location + trade-radius preference on users.
--    `geog` is a generated column from lat/lng so we never have to
--    keep them in sync manually. The GIST index on `geog` is what
--    ST_DWithin() in the discover query uses.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS zip                 TEXT,
  ADD COLUMN IF NOT EXISTS city                TEXT,
  ADD COLUMN IF NOT EXISTS state               TEXT,
  ADD COLUMN IF NOT EXISTS country             TEXT DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS lat                 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS lng                 DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS trade_radius_miles  INTEGER DEFAULT 25;

-- Generated geography column. If you've previously added `geog` by
-- hand, drop it before re-running this section.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS geog GEOGRAPHY(Point, 4326)
    GENERATED ALWAYS AS (
      CASE
        WHEN lat IS NOT NULL AND lng IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
        ELSE NULL
      END
    ) STORED;

CREATE INDEX IF NOT EXISTS users_geog_gix ON users USING GIST (geog);

-- ──────────────────────────────────────────────────────────────────────
-- 3. closet_items — per-user inventory of things they're offering for
--    in-person trade. Separate from seller_listings on purpose:
--      • open to every user, not just sellers
--      • no commerce-status enum tied to checkout flow
--      • photos are storage URLs, not base64 blobs
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closet_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  brand       TEXT,
  category    TEXT,                              -- top / bottom / shoes / acc / outerwear / ...
  size        TEXT,
  condition   TEXT,                              -- new / like-new / good / worn
  color       TEXT,
  description TEXT,
  photos      TEXT[] NOT NULL DEFAULT '{}',     -- supabase storage URLs (NOT base64)
  status      TEXT NOT NULL DEFAULT 'available', -- available / pending / traded / removed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS closet_items_owner_idx
  ON closet_items (owner_id);

-- Partial index — most discover queries filter to available items only.
CREATE INDEX IF NOT EXISTS closet_items_available_idx
  ON closet_items (created_at DESC)
  WHERE status = 'available';

ALTER TABLE closet_items ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 4. updated_at auto-touch trigger for closet_items.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS closet_items_touch_updated_at ON closet_items;
CREATE TRIGGER closet_items_touch_updated_at
  BEFORE UPDATE ON closet_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 5. discover_closet_items() — PostGIS radius query exposed as an RPC.
--    The Supabase JS client can't run raw ST_DWithin queries, so we
--    wrap the distance filter in a SECURITY INVOKER function and call
--    it via supabase.rpc('discover_closet_items', {...}).
--
--    Returns items from OTHER users (not the searcher) that are within
--    `radius_miles` of the searcher's stored zip centroid, ordered by
--    distance (closest first). Distance is included in the response,
--    rounded server-side to 1 decimal.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION discover_closet_items(
  searcher_id   UUID,
  radius_miles  NUMERIC,
  category_filter TEXT DEFAULT NULL,
  search_q      TEXT DEFAULT NULL,
  lim           INT  DEFAULT 60
)
RETURNS TABLE (
  id              UUID,
  owner_id        UUID,
  title           TEXT,
  brand           TEXT,
  category        TEXT,
  size            TEXT,
  condition       TEXT,
  color           TEXT,
  description     TEXT,
  photos          TEXT[],
  created_at      TIMESTAMPTZ,
  owner_handle    TEXT,
  owner_display   TEXT,
  owner_avatar    TEXT,
  owner_city      TEXT,
  owner_state     TEXT,
  distance_miles  NUMERIC
) AS $$
DECLARE
  searcher_geog GEOGRAPHY;
BEGIN
  -- Qualify users.id — unqualified `id` collides with the OUT column
  -- declared in RETURNS TABLE above (PL/pgSQL treats OUT names as
  -- variables that shadow column references). Without the alias this
  -- raises 42702: column reference "id" is ambiguous.
  SELECT u.geog INTO searcher_geog
  FROM users u
  WHERE u.id = searcher_id;
  IF searcher_geog IS NULL THEN
    -- Searcher has no location set — return empty so frontend can
    -- prompt for zip / use-my-location.
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    ci.id,
    ci.owner_id,
    ci.title,
    ci.brand,
    ci.category,
    ci.size,
    ci.condition,
    ci.color,
    ci.description,
    ci.photos,
    ci.created_at,
    u.handle             AS owner_handle,
    u.display_name       AS owner_display,
    u.avatar_url         AS owner_avatar,
    u.city               AS owner_city,
    u.state              AS owner_state,
    ROUND((ST_Distance(u.geog, searcher_geog) / 1609.34)::numeric, 1) AS distance_miles
  FROM closet_items ci
  JOIN users u ON u.id = ci.owner_id
  WHERE ci.status = 'available'
    AND u.id <> searcher_id
    AND u.geog IS NOT NULL
    AND ST_DWithin(u.geog, searcher_geog, radius_miles * 1609.34)
    AND (category_filter IS NULL OR ci.category = category_filter)
    AND (
      search_q IS NULL
      OR ci.title       ILIKE '%' || search_q || '%'
      OR ci.brand       ILIKE '%' || search_q || '%'
      OR ci.description ILIKE '%' || search_q || '%'
    )
  ORDER BY ST_Distance(u.geog, searcher_geog) ASC
  LIMIT lim;
END;
$$ LANGUAGE plpgsql SECURITY INVOKER STABLE;
