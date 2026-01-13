-- Custom SQL migration file, put your code below! --
-- Remove encryption from daytona preview tokens for performance.
-- Delete existing encrypted tokens (they'll be re-fetched on demand).

DELETE FROM "daytona_preview_token";--> statement-breakpoint
ALTER TABLE "daytona_preview_token" RENAME COLUMN "encrypted_token" TO "token";
