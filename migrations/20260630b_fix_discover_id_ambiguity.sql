-- Hotfix: discover_closet_items() raised
--   ERROR 42702: column reference "id" is ambiguous
-- because the function declares an OUT column `id` (via RETURNS TABLE)
-- AND references `WHERE id = searcher_id` against the users table —
-- PL/pgSQL treats the unqualified `id` as the OUT variable, not the
-- column. Result: the entire function aborts on its first SELECT, and
-- /api/trade/discover returns 500 to every caller.
--
-- Fix: qualify every column reference that collides with an OUT name
-- (id, owner_id, title, brand, ...). We rewrite the function with
-- CREATE OR REPLACE so the signature stays identical and no callers
-- need to change.
--
-- Run order: paste in the Supabase SQL Editor. NOTIFY pgrst at the end
-- forces PostgREST's schema cache to pick up the new body even though
-- the signature hasn't changed (belt-and-suspenders).

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
  -- Qualify users.id explicitly — unqualified `id` collides with the
  -- OUT column declared above.
  SELECT u.geog INTO searcher_geog
  FROM users u
  WHERE u.id = searcher_id;

  IF searcher_geog IS NULL THEN
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

NOTIFY pgrst, 'reload schema';
