CREATE TABLE "outbox_event" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

select pgmq.create('consumer_job_queue');
