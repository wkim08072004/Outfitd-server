-- Follow requests: pending approvals for private accounts.
-- Public accounts bypass this table entirely (a POST /follow creates a
-- `follows` row directly). Private accounts get a `follow_requests` row
-- until the owner accepts (moved into `follows`) or declines (deleted).
--
-- Kept as a separate table (rather than a status column on `follows`) so
-- the existing follower-count and is_following queries stay unchanged —
-- only accepted relationships live in `follows`.

CREATE TABLE IF NOT EXISTS follow_requests (
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requester_id, target_id),
  CONSTRAINT follow_requests_no_self CHECK (requester_id <> target_id)
);

-- "Who requested to follow me" — incoming inbox for the target.
CREATE INDEX IF NOT EXISTS follow_requests_target_idx ON follow_requests (target_id);
-- "Requests I've sent" — for canceling and for painting REQUESTED state.
CREATE INDEX IF NOT EXISTS follow_requests_requester_idx ON follow_requests (requester_id);

ALTER TABLE follow_requests ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
