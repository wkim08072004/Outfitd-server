-- User privacy toggle. When TRUE, only followers (plus the owner) can see
-- the user's posts. Handle/display_name/bio/avatar/banner stay visible so
-- follow flows still work.
--
-- Defaults to FALSE so every existing account stays public unless the
-- owner opts in via the settings toggle.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';
