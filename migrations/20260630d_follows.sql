-- Follows: directional, no acceptance flow (anyone can follow anyone).
-- follower_id follows followee_id; unfollow is just a row delete.
-- Self-follow blocked at the DB layer so the API layer can stay thin.
--
-- RLS on, no public policies — all access via Express service-role,
-- consistent with the other social tables in this project.

CREATE TABLE IF NOT EXISTS follows (
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
);

-- "Who follows me" lookup for the follower-count + followers list.
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);
-- "Who do I follow" lookup for the following-count + is-following check.
CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows (follower_id);

ALTER TABLE follows ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
