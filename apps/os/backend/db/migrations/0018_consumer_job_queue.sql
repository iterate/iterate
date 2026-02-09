select pgmq.create('consumer_job_queue');

-- outbox_event table for tracking all enqueued events
CREATE TABLE IF NOT EXISTS "outbox_event" (
  "id" bigserial PRIMARY KEY,
  "name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
