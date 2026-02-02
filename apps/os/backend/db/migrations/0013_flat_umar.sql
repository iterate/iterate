-- Enable pgmq extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Create outbox_event table
CREATE TABLE "outbox_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Create pgmq queue for consumer jobs
SELECT pgmq.create('consumer_job_queue');
