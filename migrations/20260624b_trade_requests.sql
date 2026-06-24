-- Trade-requests + scoped messaging (Phase 1).
--
-- Layered on top of 20260624_trade_closet.sql. The contact-to-trade
-- stub from the closet feature gets replaced by a structured
-- request flow:
--
--   • A requester sends a request for a specific closet_item.
--   • The recipient (owner) can accept, decline, or wait.
--   • Either side can post messages on the request.
--   • Either side can mark it completed once trade happens IRL.
--   • On completion, BOTH involved closet_items are marked 'traded'.
--     The "other" item is captured at completion time (the recipient
--     names what they're trading back), not at request creation.
--
-- Status state machine (enforced in routes/trade.js):
--
--   pending  → accepted   (recipient action)
--   pending  → declined   (recipient action)
--   pending  → cancelled  (requester action)
--   accepted → completed  (either action — requires return_item_id)
--   accepted → cancelled  (either action)
--   declined, completed, cancelled: TERMINAL
--
-- All tables ENABLE ROW LEVEL SECURITY with NO public policies.
-- Access is through the Express backend using the Supabase service
-- role; gating is in middleware. Matches the pattern from
-- 20260502_moderation.sql and 20260624_trade_closet.sql.

-- ──────────────────────────────────────────────────────────────────────
-- 1. trade_requests — one row per requester/recipient/item triple.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id         UUID NOT NULL REFERENCES closet_items(id) ON DELETE CASCADE,
  -- The item the recipient agrees to trade back. NULL while pending /
  -- accepted; set when the recipient completes the trade. Lets us flip
  -- both sides' closet_items.status to 'traded' atomically.
  return_item_id  UUID REFERENCES closet_items(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT trade_requests_status_chk
      CHECK (status IN ('pending','accepted','declined','cancelled','completed')),
  -- Requester can't request their own item.
  CONSTRAINT trade_requests_not_self CHECK (requester_id <> recipient_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One pending request per requester/item pair — blocks dup spam.
-- Terminal-status requests don't count (so you can re-request after a
-- decline). Uses a partial unique index instead of a CHECK constraint.
CREATE UNIQUE INDEX IF NOT EXISTS trade_requests_one_pending_per_item
  ON trade_requests (requester_id, item_id)
  WHERE status IN ('pending','accepted');

CREATE INDEX IF NOT EXISTS trade_requests_inbox_idx
  ON trade_requests (recipient_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS trade_requests_outbox_idx
  ON trade_requests (requester_id, status, created_at DESC);

ALTER TABLE trade_requests ENABLE ROW LEVEL SECURITY;

-- updated_at auto-touch (reuses helper from 20260624_trade_closet.sql).
DROP TRIGGER IF EXISTS trade_requests_touch_updated_at ON trade_requests;
CREATE TRIGGER trade_requests_touch_updated_at
  BEFORE UPDATE ON trade_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────
-- 2. trade_request_messages — chronological thread per request.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_request_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES trade_requests(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  -- NULL until the OTHER side (not the sender) marks it read. Drives
  -- the inbox unread badge.
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trade_request_messages_thread_idx
  ON trade_request_messages (request_id, created_at);

-- Per-recipient unread lookup: "rows where I'm not the sender and
-- read_at is null." Backend filters by request->recipient/requester
-- join so we don't need a sender-aware partial index.
CREATE INDEX IF NOT EXISTS trade_request_messages_unread_idx
  ON trade_request_messages (request_id)
  WHERE read_at IS NULL;

ALTER TABLE trade_request_messages ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────────────
-- 3. Trigger: on status → 'completed', mark BOTH closet_items 'traded'.
--    Idempotent — only fires when status actually transitions to
--    completed. If return_item_id is null at completion the trigger
--    aborts the update so the backend has to provide it.
-- ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trade_request_on_complete()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' AND COALESCE(OLD.status, '') <> 'completed' THEN
    IF NEW.return_item_id IS NULL THEN
      RAISE EXCEPTION 'return_item_id required to complete a trade request';
    END IF;
    -- Mark both items traded. Status='traded' is a closet_items value
    -- already defined in 20260624_trade_closet.sql.
    UPDATE closet_items
       SET status = 'traded'
     WHERE id IN (NEW.item_id, NEW.return_item_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_requests_complete_trigger ON trade_requests;
CREATE TRIGGER trade_requests_complete_trigger
  BEFORE UPDATE ON trade_requests
  FOR EACH ROW EXECUTE FUNCTION trade_request_on_complete();
