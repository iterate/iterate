ALTER TABLE "builds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "builds" DROP COLUMN "output";