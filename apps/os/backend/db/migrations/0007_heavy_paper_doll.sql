CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"commit_hash" text NOT NULL,
	"commit_message" text NOT NULL,
	"iterate_workflow_run_id" text,
	"webhook_iterate_id" text NOT NULL,
	"estate_id" text NOT NULL,
	"completed_at" timestamp,
	"output" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
