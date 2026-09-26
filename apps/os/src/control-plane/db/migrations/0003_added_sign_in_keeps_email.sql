-- A person with a sign-in they added keeps their email: the address an added sign-in's provider
-- reports is never theirs (catalog.ts `linkIdentity` never writes it), and this refuses the write
-- from anything else, such as a version of the platform older than `added_at`. An operator who
-- must change such an email clears the identity's `added_at` first.
create trigger users_email_kept_by_added_sign_in
before update of email on users
when new.email <> old.email
  and exists (select 1 from identities i where i.user_id = old.id and i.added_at is not null)
begin
  select raise(abort, 'an added sign-in keeps its person''s email');
end;
