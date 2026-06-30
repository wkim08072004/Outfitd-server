-- Closet squads (shared trade-closets).
--
-- Layered on top of 20260624_trade_closet.sql. A "squad" is a shared
-- VIEW over closet_items contributed by multiple members. The point is
-- friend-sharing — every item still physically belongs to one real
-- person, trade requests still route to that person via
-- /api/trade/requests, and Discover is untouched. This migration only
-- adds the membership + per-squad item join table.
--
-- Privacy / scope invariants kept consistent with the trade-closet
-- migration:
--   • No new location columns. Items inherit their owner's stored zip
--     centroid via the existing users.lat/lng/city/state.
--   • RLS enabled, no public policies — all gating in Express.
--   • Squads are NOT a Discover surface. Discover keeps using the
--     existing discover_closet_items() RPC unchanged.
--
-- Run order:
--   1. Run THIS migration in the Supabase SQL Editor.
--   2. Deploy the backend so the new /api/trade/squads endpoints are live.
--   3. NOTIFY pgrst, 'reload schema' at the bottom runs automatically.

-- ──────────────────────────────────────────────────────────────────────
-- 1. closet_squads — the shared group itself.
--    invite_code is the URL-safe token a member shares to invite
--    others; rotating it invalidates any pending invite link that
--    used the old code. owner_id is the single explicit owner (members
--    can be promoted to 'admin' but only one 'owner' role exists per
--    squad — see closet_squad_members_one_owner index below).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closet_squads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT closet_squads_name_len
    CHECK (char_length(name) BETWEEN 2 AND 40),
  CONSTRAINT closet_squads_desc_len
    CHECK (description IS NULL OR char_length(description) <= 280)
);

CREATE INDEX IF NOT EXISTS closet_squads_owner_idx
  ON closet_squads (owner_id);

ALTER TABLE closet_squads ENABLE ROW LEVEL SECURITY;

-- updated_at auto-touch (reuses touch_updated_at() from trade-closet).
DROP TRIGGER IF EXISTS closet_squads_touch_updated_at ON closet_squads;
CREATE TRIGGER closet_squads_touch_updated_at
  BEFORE UPDATE ON closet_squads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 2. closet_squad_members — membership + role + invite acceptance.
--    status='invited' means the user has been added by an owner/admin
--    or arrived via an invite code but hasn't accepted yet; they see
--    only an invite landing card. status='active' means full access.
--    role enum: owner / admin / member. Exactly one owner per squad
--    is enforced by the partial unique index below.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closet_squad_members (
  squad_id    UUID NOT NULL REFERENCES closet_squads(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member',
  status      TEXT NOT NULL DEFAULT 'invited',
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  invited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at   TIMESTAMPTZ,
  PRIMARY KEY (squad_id, user_id),
  CONSTRAINT closet_squad_members_role_chk
    CHECK (role IN ('owner','admin','member')),
  CONSTRAINT closet_squad_members_status_chk
    CHECK (status IN ('invited','active')),
  -- Owners must be active. Catches the only-owner-can-leave-by-transfer
  -- edge case at the DB level too.
  CONSTRAINT closet_squad_members_owner_active
    CHECK (role <> 'owner' OR status = 'active')
);

-- One owner row per squad. Partial unique on role='owner'.
CREATE UNIQUE INDEX IF NOT EXISTS closet_squad_members_one_owner
  ON closet_squad_members (squad_id)
  WHERE role = 'owner';

-- "What squads am I in?" lookup. status included so the frontend can
-- separate active squads from pending invites in a single query.
CREATE INDEX IF NOT EXISTS closet_squad_members_user_idx
  ON closet_squad_members (user_id, status);

ALTER TABLE closet_squad_members ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 3. closet_squad_items — join table. An item appears in a squad
--    without duplication. contributor_user_id is denormalised from
--    closet_items.owner_id so we can quickly find "what did this
--    user contribute" without joining closet_items, and so we can
--    delete a member's contributions in one DELETE on member removal.
--    The route layer enforces contributor_user_id = closet_items.owner_id
--    at write time.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closet_squad_items (
  squad_id            UUID NOT NULL REFERENCES closet_squads(id) ON DELETE CASCADE,
  item_id             UUID NOT NULL REFERENCES closet_items(id) ON DELETE CASCADE,
  contributor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (squad_id, item_id)
);

-- Squad detail grid: items in this squad, newest first.
CREATE INDEX IF NOT EXISTS closet_squad_items_squad_idx
  ON closet_squad_items (squad_id, added_at DESC);

-- "Pull this member's items from this squad" on remove/leave.
CREATE INDEX IF NOT EXISTS closet_squad_items_contrib_idx
  ON closet_squad_items (contributor_user_id, squad_id);

ALTER TABLE closet_squad_items ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 4. PostgREST schema reload so Supabase service-role client sees the
--    new tables without a manual restart.
-- ──────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
