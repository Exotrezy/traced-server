-- OPTIONAL for databases missing these fields only. Mikael's live database already has all four columns. Do not rerun there.
-- Recording still works if location columns are absent. Back up and inspect your schema before a migration.
ALTER TABLE opens ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE opens ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE clicks ADD COLUMN country TEXT NOT NULL DEFAULT '';
