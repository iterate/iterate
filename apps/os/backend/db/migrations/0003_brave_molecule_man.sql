ALTER TABLE "project_access_token" RENAME COLUMN "token_hash" TO "encrypted_token";--> statement-breakpoint
ALTER TABLE "project_access_token" ALTER COLUMN "last_used_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_access_token" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine" DROP COLUMN "api_key_hash";