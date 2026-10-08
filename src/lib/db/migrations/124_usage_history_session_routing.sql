-- Migration 124: Add privacy-safe session-routing diagnostics to usage history.
-- session_hash is a one-way SHA-256 correlation value; raw session identifiers
-- and prompt/cache keys must never be stored in this table.
ALTER TABLE usage_history ADD COLUMN session_hash TEXT;
ALTER TABLE usage_history ADD COLUMN session_source TEXT;
ALTER TABLE usage_history ADD COLUMN routing_reason TEXT;
ALTER TABLE usage_history ADD COLUMN previous_connection_id TEXT;

CREATE INDEX IF NOT EXISTS idx_uh_session_hash ON usage_history(session_hash);
CREATE INDEX IF NOT EXISTS idx_uh_routing_reason ON usage_history(routing_reason);
