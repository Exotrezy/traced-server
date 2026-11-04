-- Traced D1 schema (v2) — for a FRESH database.
--   npx wrangler d1 execute traced-db --remote --file=schema.sql
--
-- Already have a live database from v1?  Do NOT run this file.
-- Run migrations/0002_v2.sql once instead.

CREATE TABLE IF NOT EXISTS emails (
  tracking_id   TEXT PRIMARY KEY,
  subject       TEXT NOT NULL DEFAULT '',
  recipient     TEXT NOT NULL DEFAULT '',
  sender_email  TEXT NOT NULL DEFAULT '',
  sender_ip     TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  options       TEXT NOT NULL DEFAULT '{}',
  owner_hash    TEXT NOT NULL DEFAULT ''      -- SHA-256 of the installing user's key
);

-- Written when a compose window opens (and again on send). The pixel endpoints only
-- record hits for IDs found here, so random URLs can't create rows.
CREATE TABLE IF NOT EXISTS reg_timestamps (
  tracking_id   TEXT PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  sender_ip     TEXT NOT NULL DEFAULT '',
  owner_hash    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS opens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_id   TEXT NOT NULL,
  time          TEXT NOT NULL,
  ip            TEXT NOT NULL DEFAULT '',
  ua            TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT '',
  client        TEXT NOT NULL DEFAULT '',
  pixel_type    TEXT NOT NULL DEFAULT 'top',
  via_proxy     INTEGER NOT NULL DEFAULT 0,
  city          TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (tracking_id) REFERENCES emails(tracking_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS links (
  link_id       TEXT PRIMARY KEY,
  tracking_id   TEXT NOT NULL,
  url           TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (tracking_id) REFERENCES emails(tracking_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS clicks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id       TEXT NOT NULL,
  tracking_id   TEXT NOT NULL,
  time          TEXT NOT NULL,
  ip            TEXT NOT NULL DEFAULT '',
  ua            TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT '',
  client        TEXT NOT NULL DEFAULT '',
  is_bot        INTEGER NOT NULL DEFAULT 0,   -- link scanners / previewers: kept, never counted as a person
  city          TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (link_id) REFERENCES links(link_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_opens_tracking_id   ON opens(tracking_id, time);
CREATE INDEX IF NOT EXISTS idx_links_tracking_id   ON links(tracking_id);
CREATE INDEX IF NOT EXISTS idx_clicks_link_id      ON clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_tracking_id  ON clicks(tracking_id, time);
CREATE INDEX IF NOT EXISTS idx_emails_owner        ON emails(owner_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_created      ON emails(created_at);
