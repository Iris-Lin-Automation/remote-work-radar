CREATE TABLE IF NOT EXISTS v2ex_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id BIGINT NOT NULL,
  topic_url TEXT NOT NULL,
  topic_title TEXT NOT NULL,
  reply_id BIGINT NOT NULL,
  author_username TEXT,
  reply_content TEXT NOT NULL,
  reply_created_at TIMESTAMPTZ,
  possible_peer_offer BOOLEAN NOT NULL DEFAULT FALSE,
  peer_offer_reason TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (topic_id, reply_id)
);

CREATE INDEX IF NOT EXISTS idx_v2ex_replies_topic_created
  ON v2ex_replies (topic_id, reply_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_v2ex_replies_possible_peer_offer
  ON v2ex_replies (possible_peer_offer, reply_created_at DESC);
