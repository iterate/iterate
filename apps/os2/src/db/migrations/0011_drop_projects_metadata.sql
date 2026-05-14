-- Drop the metadata column from projects.
-- SQLite supports ALTER TABLE DROP COLUMN since 3.35.0.
alter table projects drop column metadata;
