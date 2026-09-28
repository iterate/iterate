-- WHEN A PERSON ADDED A SIGN-IN to their own account (catalog.ts `addIdentity`): null for every
-- identity a sign-in linked, which is every one before this column.
alter table identities add column added_at integer;
