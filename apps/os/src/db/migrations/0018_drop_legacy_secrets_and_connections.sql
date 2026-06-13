-- The clean cut: secrets and integration connections are journal-backed
-- domain objects now (/secrets/{slug} + SecretDurableObject,
-- /integrations/{slug}/{account} + IntegrationDurableObject). The D1 layer
-- they replace dies here. OAuth state became a signed stateless token.
drop table if exists oauth_states;
drop table if exists project_secrets;
drop table if exists project_connections;
