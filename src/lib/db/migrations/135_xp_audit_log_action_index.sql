-- Migration 135: Index per-key action lookups in the XP audit log.
-- Badge checks count rows by (api_key_id, action) after every request; the
-- existing (api_key_id, created_at) index forced a scan of every row of the key.
CREATE INDEX IF NOT EXISTS idx_xp_audit_log_api_key_action
  ON xp_audit_log (api_key_id, action);
