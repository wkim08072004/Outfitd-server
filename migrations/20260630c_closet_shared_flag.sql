-- Replace explicit per-squad item picking with a single `shared` flag
-- on each closet item.
--
-- BEFORE: closet_squad_items (squad_id × item_id) was an opt-in join.
-- Each contributor picked, per squad, which of their items to pool.
--
-- AFTER:  closet_items.shared is a global boolean. If true, the item
-- appears in EVERY squad the owner is an active member of. If false,
-- it appears in none. Squad detail queries derive the item list at
-- read time from active membership ∩ shared items; the join table is
-- no longer needed.
--
-- Default is TRUE for both new and existing rows — the product
-- preference is opt-out, not opt-in. Anyone who wants an item kept
-- private can flick the toggle on the MY CLOSET card.

ALTER TABLE closet_items
  ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT TRUE;

-- Defensive backfill in case the column already existed nullable.
UPDATE closet_items SET shared = TRUE WHERE shared IS NULL;

-- Squad detail derives its grid from (member, shared, available);
-- the explicit join is dead weight.
DROP TABLE IF EXISTS closet_squad_items;

NOTIFY pgrst, 'reload schema';
