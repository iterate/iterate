-- Create the new mcp_connection table
CREATE TABLE "mcp_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"server_url" text NOT NULL,
	"mode" text NOT NULL,
	"user_id" text,
	"estate_id" text NOT NULL,
	"auth_type" text NOT NULL,
	"account_id" text,
	"integration_slug" text NOT NULL,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Add foreign keys for mcp_connection
ALTER TABLE "mcp_connection" ADD CONSTRAINT "mcp_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connection" ADD CONSTRAINT "mcp_connection_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connection" ADD CONSTRAINT "mcp_connection_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Create indexes for mcp_connection
CREATE UNIQUE INDEX "mcp_conn_personal_unique" ON "mcp_connection" USING btree ("estate_id","server_url","user_id") WHERE "mcp_connection"."mode" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_conn_company_unique" ON "mcp_connection" USING btree ("estate_id","server_url") WHERE "mcp_connection"."mode" = 'company';--> statement-breakpoint
CREATE INDEX "mcp_conn_estate_idx" ON "mcp_connection" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "mcp_conn_user_idx" ON "mcp_connection" USING btree ("user_id");--> statement-breakpoint

-- Migrate existing param-based MCP connections to mcp_connection table
-- Create one connection row per unique (estate_id, connection_key)
INSERT INTO "mcp_connection" ("id", "server_url", "mode", "user_id", "estate_id", "auth_type", "integration_slug", "connected_at", "created_at", "updated_at")
SELECT DISTINCT ON (old.estate_id, old.connection_key)
  'mcpc_' || substr(md5(old.connection_key || old.estate_id), 1, 26) as id,
  split_part(old.connection_key, '::', 1) as server_url,
  CASE 
    WHEN old.connection_key LIKE '%::company' THEN 'company'
    ELSE 'personal'
  END as mode,
  CASE 
    WHEN old.connection_key LIKE '%::personal::%' THEN split_part(old.connection_key, '::', 3)
    ELSE NULL
  END as user_id,
  old.estate_id,
  'params' as auth_type,
  -- Generate integration slug from server URL hostname
  COALESCE(
    regexp_replace(
      regexp_replace(
        substring(split_part(old.connection_key, '::', 1) from '://([^/:]+)'),
        '[^a-zA-Z0-9]', '-', 'g'
      ),
      '-+', '-', 'g'
    ),
    'unknown'
  ) as integration_slug,
  old.created_at as connected_at,
  old.created_at,
  old.updated_at
FROM "mcp_connection_param" old
WHERE old.connection_key IS NOT NULL
ORDER BY old.estate_id, old.connection_key, old.created_at;--> statement-breakpoint

-- Drop old constraints and indexes from mcp_connection_param
ALTER TABLE "mcp_connection_param" DROP CONSTRAINT IF EXISTS "mcp_connection_param_estate_id_estate_id_fk";--> statement-breakpoint
ALTER TABLE "mcp_connection_param" DROP CONSTRAINT IF EXISTS "mcp_connection_param_user_id_user_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_connection_param_estate_id_connection_key_param_key_param_type_index";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_personal_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_company_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_connection_param_estate_id_index";--> statement-breakpoint
DROP INDEX IF EXISTS "mcp_connection_param_connection_key_index";--> statement-breakpoint

-- Add connection_id column as nullable first
ALTER TABLE "mcp_connection_param" ADD COLUMN "connection_id" text;--> statement-breakpoint

-- Populate connection_id by matching on estate_id and connection_key
UPDATE "mcp_connection_param" p
SET connection_id = c.id
FROM "mcp_connection" c
WHERE c.estate_id = p.estate_id
  AND c.server_url = split_part(p.connection_key, '::', 1)
  AND (
    (c.mode = 'company' AND p.connection_key LIKE '%::company')
    OR (c.mode = 'personal' AND p.connection_key LIKE '%::personal::%' AND c.user_id = split_part(p.connection_key, '::', 3))
  );--> statement-breakpoint

-- Now make connection_id NOT NULL
ALTER TABLE "mcp_connection_param" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint

-- Add foreign key constraint for connection_id
ALTER TABLE "mcp_connection_param" ADD CONSTRAINT "mcp_connection_param_connection_id_mcp_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Create new indexes for mcp_connection_param
CREATE UNIQUE INDEX "mcp_param_unique" ON "mcp_connection_param" USING btree ("connection_id","param_key","param_type");--> statement-breakpoint
CREATE INDEX "mcp_param_conn_idx" ON "mcp_connection_param" USING btree ("connection_id");--> statement-breakpoint

-- Drop old columns from mcp_connection_param
ALTER TABLE "mcp_connection_param" DROP COLUMN IF EXISTS "connection_key";--> statement-breakpoint
ALTER TABLE "mcp_connection_param" DROP COLUMN IF EXISTS "server_url";--> statement-breakpoint
ALTER TABLE "mcp_connection_param" DROP COLUMN IF EXISTS "mode";--> statement-breakpoint
ALTER TABLE "mcp_connection_param" DROP COLUMN IF EXISTS "user_id";--> statement-breakpoint
ALTER TABLE "mcp_connection_param" DROP COLUMN IF EXISTS "estate_id";--> statement-breakpoint

-- Migrate existing OAuth MCP connections to mcp_connection table
-- These were previously identified by accounts with providerId not in known OAuth providers list
-- Known OAuth providers: github-app, slack-bot, google, slack
INSERT INTO "mcp_connection" (
  "id",
  "server_url",
  "mode",
  "user_id",
  "estate_id",
  "auth_type",
  "account_id",
  "integration_slug",
  "connected_at",
  "created_at",
  "updated_at"
)
SELECT
  'mcpc_' || substr(md5(a.id || eap.estate_id), 1, 26) as id,
  -- Use providerId as server URL since that's what we have (e.g. "mcp-linear" or a URL)
  a.provider_id as server_url,
  'personal' as mode,
  a.user_id as user_id,
  eap.estate_id as estate_id,
  'oauth' as auth_type,
  a.id as account_id,
  -- Generate integration slug from provider_id
  COALESCE(
    regexp_replace(
      regexp_replace(
        a.provider_id,
        '[^a-zA-Z0-9]', '-', 'g'
      ),
      '-+', '-', 'g'
    ),
    'unknown'
  ) as integration_slug,
  a.created_at as connected_at,
  a.created_at as created_at,
  a.updated_at as updated_at
FROM "account" a
INNER JOIN "estate_accounts_permissions" eap ON eap.account_id = a.id
WHERE a.provider_id NOT IN ('github-app', 'slack-bot', 'google', 'slack')
  -- Only migrate if not already migrated
  AND NOT EXISTS (
    SELECT 1 FROM "mcp_connection" mc
    WHERE mc.account_id = a.id
      AND mc.estate_id = eap.estate_id
  )
ON CONFLICT DO NOTHING;
