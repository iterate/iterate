select pgmq.create('consumer_job_queue');

CREATE TABLE "outbox_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- DROP INDEX "project_organization_id_slug_index";--> statement-breakpoint
-- ALTER TABLE "project" ADD CONSTRAINT "project_slug_unique" UNIQUE("slug");
