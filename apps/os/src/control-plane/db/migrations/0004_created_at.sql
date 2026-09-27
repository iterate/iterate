-- WHEN AN ORGANIZATION, A MEMBERSHIP OR A PROJECT WAS CREATED (epoch ms; for a membership, when the
-- person joined). Null for every row before these columns: nothing recorded when those were made,
-- and a list ordered by it holds them first, as they are the oldest. Nullable, so the version still
-- running while this lands (it names none of them) goes on writing its rows.
alter table organizations add column created_at integer;
alter table memberships add column created_at integer;
alter table projects add column created_at integer;
