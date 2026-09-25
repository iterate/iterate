/** @name userByRef */
select id, email from users where id = :id or email = :email limit 1;

/** @name listUsers */
select id, email from users order by email;

/** @name insertUserIfNew */
insert into users (id, email) values (:id, :email) on conflict (email) do nothing;

/** @name updateUserEmail */
update users set email = :email where id = :id;

/** @name identityUser */
select u.id, u.email
from identities i
join users u on u.id = i.user_id
where i.provider = :provider and i.subject = :subject
limit 1;

/** @name insertUserUnlessLinked */
insert into users (id, email)
select :id, :email
where not exists (select 1 from identities i where i.provider = :provider and i.subject = :subject)
on conflict (email) do nothing;

/** @name insertIdentity */
insert into identities (provider, subject, user_id)
select :provider, :subject, u.id from users u where u.email = :email
on conflict do nothing;
