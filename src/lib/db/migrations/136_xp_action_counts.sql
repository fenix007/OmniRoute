-- Migration 136: Durable per-key/per-action gamification counters (upstream #12651).
--
-- Action-count badges used to count xp_audit_log rows, which the retention prune
-- (cleanupXpAuditLog) now ages out. This table keeps a running lifetime total per
-- (api_key_id, action) that the prune never touches, like user_levels.total_xp.

CREATE TABLE IF NOT EXISTS xp_action_counts (
  api_key_id TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (api_key_id, action)
) WITHOUT ROWID;

-- Backfill from the audit rows that exist before the first prune. Same per-row
-- weight as addXp(): metadata `amount` when present, otherwise 1.
INSERT OR IGNORE INTO xp_action_counts (api_key_id, action, count, updated_at)
SELECT
  api_key_id,
  action,
  SUM(COALESCE(CAST(json_extract(metadata, '$.amount') AS INTEGER), 1)) AS count,
  datetime('now')
FROM xp_audit_log
GROUP BY api_key_id, action;
