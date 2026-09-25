/** @name oauthGrant */
select value from oauth_grants where key = :key and (expires_at is null or expires_at > :now);

/** @name listOAuthGrants */
select key, expires_at as expiresAt
from oauth_grants
where key > max(:cursor, :prefix)
  and key < :end
  and (expires_at is null or expires_at > :now)
order by key
limit :limit;

/** @name purgeExpiredOAuthGrants */
delete from oauth_grants where expires_at <= :now;

/** @name upsertOAuthGrant */
insert into oauth_grants (key, value, expires_at) values (:key, :value, :expiresAt)
on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at;

/** @name deleteOAuthGrant */
delete from oauth_grants where key = :key;
