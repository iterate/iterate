CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE OR REPLACE FUNCTION iterate_typeid_base32(src bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  WITH bytes AS (
    SELECT
      get_byte(src, 0) AS b0,
      get_byte(src, 1) AS b1,
      get_byte(src, 2) AS b2,
      get_byte(src, 3) AS b3,
      get_byte(src, 4) AS b4,
      get_byte(src, 5) AS b5,
      get_byte(src, 6) AS b6,
      get_byte(src, 7) AS b7,
      get_byte(src, 8) AS b8,
      get_byte(src, 9) AS b9,
      get_byte(src, 10) AS b10,
      get_byte(src, 11) AS b11,
      get_byte(src, 12) AS b12,
      get_byte(src, 13) AS b13,
      get_byte(src, 14) AS b14,
      get_byte(src, 15) AS b15
  ),
  alphabet AS (
    SELECT '0123456789abcdefghjkmnpqrstvwxyz'::text AS value
  )
  SELECT
    substr(alphabet.value, ((bytes.b0 & 224) >> 5) + 1, 1) ||
    substr(alphabet.value, (bytes.b0 & 31) + 1, 1) ||
    substr(alphabet.value, ((bytes.b1 & 248) >> 3) + 1, 1) ||
    substr(alphabet.value, (((bytes.b1 & 7) << 2) | ((bytes.b2 & 192) >> 6)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b2 & 62) >> 1) + 1, 1) ||
    substr(alphabet.value, (((bytes.b2 & 1) << 4) | ((bytes.b3 & 240) >> 4)) + 1, 1) ||
    substr(alphabet.value, (((bytes.b3 & 15) << 1) | ((bytes.b4 & 128) >> 7)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b4 & 124) >> 2) + 1, 1) ||
    substr(alphabet.value, (((bytes.b4 & 3) << 3) | ((bytes.b5 & 224) >> 5)) + 1, 1) ||
    substr(alphabet.value, (bytes.b5 & 31) + 1, 1) ||
    substr(alphabet.value, ((bytes.b6 & 248) >> 3) + 1, 1) ||
    substr(alphabet.value, (((bytes.b6 & 7) << 2) | ((bytes.b7 & 192) >> 6)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b7 & 62) >> 1) + 1, 1) ||
    substr(alphabet.value, (((bytes.b7 & 1) << 4) | ((bytes.b8 & 240) >> 4)) + 1, 1) ||
    substr(alphabet.value, (((bytes.b8 & 15) << 1) | ((bytes.b9 & 128) >> 7)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b9 & 124) >> 2) + 1, 1) ||
    substr(alphabet.value, (((bytes.b9 & 3) << 3) | ((bytes.b10 & 224) >> 5)) + 1, 1) ||
    substr(alphabet.value, (bytes.b10 & 31) + 1, 1) ||
    substr(alphabet.value, ((bytes.b11 & 248) >> 3) + 1, 1) ||
    substr(alphabet.value, (((bytes.b11 & 7) << 2) | ((bytes.b12 & 192) >> 6)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b12 & 62) >> 1) + 1, 1) ||
    substr(alphabet.value, (((bytes.b12 & 1) << 4) | ((bytes.b13 & 240) >> 4)) + 1, 1) ||
    substr(alphabet.value, (((bytes.b13 & 15) << 1) | ((bytes.b14 & 128) >> 7)) + 1, 1) ||
    substr(alphabet.value, ((bytes.b14 & 124) >> 2) + 1, 1) ||
    substr(alphabet.value, (((bytes.b14 & 3) << 3) | ((bytes.b15 & 224) >> 5)) + 1, 1) ||
    substr(alphabet.value, (bytes.b15 & 31) + 1, 1)
  FROM bytes, alphabet;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION iterate_typeid(prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  ts_ms bigint;
  rand_hex text;
  variant_nibble text;
  uuid_hex text;
BEGIN
  IF prefix !~ '^[a-z](?:[a-z_]{0,61}[a-z])?$' THEN
    RAISE EXCEPTION 'Invalid TypeID prefix: %', prefix;
  END IF;

  ts_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  rand_hex := encode(gen_random_bytes(9), 'hex');
  variant_nibble := substr('89ab', (get_byte(gen_random_bytes(1), 0) % 4) + 1, 1);
  uuid_hex := lpad(to_hex(ts_ms), 12, '0')
    || '7'
    || substr(rand_hex, 1, 3)
    || variant_nibble
    || substr(rand_hex, 4, 15);

  RETURN prefix || '_' || iterate_typeid_base32(decode(uuid_hex, 'hex'));
END;
$$;--> statement-breakpoint
ALTER TABLE "better_auth_account" ALTER COLUMN "id" SET DEFAULT iterate_typeid('acc');--> statement-breakpoint
ALTER TABLE "billing_account" ALTER COLUMN "id" SET DEFAULT iterate_typeid('bill');--> statement-breakpoint
ALTER TABLE "daytona_preview_token" ALTER COLUMN "id" SET DEFAULT iterate_typeid('dtpv');--> statement-breakpoint
ALTER TABLE "device_code" ALTER COLUMN "id" SET DEFAULT iterate_typeid('dvc');--> statement-breakpoint
ALTER TABLE "egress_approval" ALTER COLUMN "id" SET DEFAULT iterate_typeid('ega');--> statement-breakpoint
ALTER TABLE "egress_policy" ALTER COLUMN "id" SET DEFAULT iterate_typeid('egp');--> statement-breakpoint
ALTER TABLE "machine" ALTER COLUMN "id" SET DEFAULT iterate_typeid('mach');--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "id" SET DEFAULT iterate_typeid('org');--> statement-breakpoint
ALTER TABLE "organization_invite" ALTER COLUMN "id" SET DEFAULT iterate_typeid('inv');--> statement-breakpoint
ALTER TABLE "organization_user_membership" ALTER COLUMN "id" SET DEFAULT iterate_typeid('member');--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "id" SET DEFAULT iterate_typeid('prj');--> statement-breakpoint
ALTER TABLE "project_access_token" ALTER COLUMN "id" SET DEFAULT iterate_typeid('pat');--> statement-breakpoint
ALTER TABLE "project_connection" ALTER COLUMN "id" SET DEFAULT iterate_typeid('conn');--> statement-breakpoint
ALTER TABLE "project_env_var" ALTER COLUMN "id" SET DEFAULT iterate_typeid('env');--> statement-breakpoint
ALTER TABLE "secret" ALTER COLUMN "id" SET DEFAULT iterate_typeid('sec');--> statement-breakpoint
ALTER TABLE "better_auth_session" ALTER COLUMN "id" SET DEFAULT iterate_typeid('ses');--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT iterate_typeid('usr');--> statement-breakpoint
ALTER TABLE "better_auth_verification" ALTER COLUMN "id" SET DEFAULT iterate_typeid('ver');