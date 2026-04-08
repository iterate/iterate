-- Custom SQL migration file, put your code below! --
INSERT INTO `codemode_secrets` (`id`, `key`, `value`, `description`, `created_at`, `updated_at`)
SELECT
  'seed_demo_echo',
  'demo.echo',
  'super-secret-inline-proof',
  'Harmless seeded secret for inline OpenAPI echo demos',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM `codemode_secrets`
  WHERE `key` = 'demo.echo'
);

INSERT INTO `codemode_secrets` (`id`, `key`, `value`, `description`, `created_at`, `updated_at`)
SELECT
  'seed_demo_inline_bearer',
  'demo.inline.bearer',
  'seeded-inline-bearer-token',
  'Harmless seeded bearer token for header injection demos',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM `codemode_secrets`
  WHERE `key` = 'demo.inline.bearer'
);
