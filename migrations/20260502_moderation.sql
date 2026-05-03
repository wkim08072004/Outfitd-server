-- Image moderation pipeline tables.
--
-- All five tables ENABLE ROW LEVEL SECURITY with NO public policies. That
-- means: the Supabase service role (used by the Express backend) can
-- read/write everything, and every other client (anon key, user-context
-- key) is denied. Admin reads/writes go through Express with requireAdmin.
--
-- Run this from the Supabase SQL Editor. After running, do:
--   NOTIFY pgrst, 'reload schema';
-- so PostgREST picks up the new tables.

-- ──────────────────────────────────────────────────────────────────────
-- 1. Banned image hashes — exact-match block list keyed by SHA-256.
--    Populated when a hard-rejected image is detected, or manually by
--    admin. Subsequent uploads that hash to the same value are rejected
--    before any classifier runs.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS banned_image_hashes (
  sha256       TEXT PRIMARY KEY,
  reason       TEXT NOT NULL,
  banned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  banned_by    UUID
);
ALTER TABLE banned_image_hashes ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 2. Forensic record of every uploaded image's hash. Lets us trace
--    re-uploads, identify clusters, and respond to legal inquiries.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS image_hashes (
  id           BIGSERIAL PRIMARY KEY,
  sha256       TEXT NOT NULL,
  uploader_id  UUID,
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS image_hashes_sha256_idx ON image_hashes(sha256);
CREATE INDEX IF NOT EXISTS image_hashes_uploader_idx ON image_hashes(uploader_id);
ALTER TABLE image_hashes ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Audit log of every classifier decision. One row per classifier
--    call. `raw` carries the upstream response so we can re-tune
--    thresholds later without losing detail.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS moderation_results (
  id           BIGSERIAL PRIMARY KEY,
  sha256       TEXT,
  uploader_id  UUID,
  image_url    TEXT,
  classifier   TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('pass','soft_flag','reject')),
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS moderation_results_sha256_idx ON moderation_results(sha256);
CREATE INDEX IF NOT EXISTS moderation_results_action_idx ON moderation_results(action);
CREATE INDEX IF NOT EXISTS moderation_results_uploader_idx ON moderation_results(uploader_id);
ALTER TABLE moderation_results ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 4. Soft-flagged uploads queue. Admin works these via
--    /api/admin/moderation/queue. `image_url` is the public URL of the
--    upload; we still let the public see soft-flagged content today
--    (see README — strict private storage is Phase 2 once the frontend
--    has a pending state plumbed through every consumer).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS flagged_uploads (
  id           BIGSERIAL PRIMARY KEY,
  sha256       TEXT,
  uploader_id  UUID,
  image_url    TEXT,
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  UUID,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS flagged_uploads_status_idx ON flagged_uploads(status);
CREATE INDEX IF NOT EXISTS flagged_uploads_created_idx ON flagged_uploads(created_at DESC);
ALTER TABLE flagged_uploads ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 5. CSAM-suspected reports. Defense-in-depth only.
--    Primary detection requires PhotoDNA (Microsoft approval) and
--    NCMEC reporting requires registration as an Electronic Service
--    Provider per 18 U.S.C. § 2258A. Until both are in place rows here
--    represent classifier suspicion and require manual handling.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS csam_reports (
  id                     BIGSERIAL PRIMARY KEY,
  sha256                 TEXT,
  uploader_id            UUID,
  classifier             TEXT,
  reasons                JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  reported_to_ncmec_at   TIMESTAMPTZ,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS csam_reports_created_idx ON csam_reports(created_at DESC);
ALTER TABLE csam_reports ENABLE ROW LEVEL SECURITY;
