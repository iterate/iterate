UPDATE "machine"
SET "metadata" = ("metadata" - 'localDocker') || jsonb_build_object(
  'docker',
  COALESCE("metadata"->'docker', '{}'::jsonb) || COALESCE("metadata"->'localDocker', '{}'::jsonb)
)
WHERE "metadata" ? 'localDocker';
