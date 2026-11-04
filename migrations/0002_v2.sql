-- Traced v1 -> v2 migration. Run ONCE against your live database:
--   npx wrangler d1 execute traced-db --remote --file=migrations/0002_v2.sql
--
-- Assumes your live DB already has opens.slot and reg_timestamps.sender_ip
-- (add_slot.sql and add_sender_ip.sql from v1). Both are harmless to keep.
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so if a statement fails with
-- "duplicate column name" it was already applied — skip it and continue.

ALTER TABLE emails         ADD COLUMN owner_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE reg_timestamps ADD COLUMN owner_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks         ADD COLUMN is_bot     INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_opens_tracking_time ON opens(tracking_id, time);
CREATE INDEX IF NOT EXISTS idx_clicks_tracking_time ON clicks(tracking_id, time);
CREATE INDEX IF NOT EXISTS idx_emails_owner        ON emails(owner_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_created      ON emails(created_at);

-- v1 data was not tied to any owner, so it stays invisible to the new dashboard
-- (this is what stops one user reading another's data). To start clean:
--   DELETE FROM clicks; DELETE FROM links; DELETE FROM opens; DELETE FROM emails; DELETE FROM reg_timestamps;
-- The debug_log table is no longer used:
--   DROP TABLE IF EXISTS debug_log;
