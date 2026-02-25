CREATE INDEX "outbox_event_machine_id_name_id_idx" ON "outbox_event" USING btree (("payload"->>'machineId'),"name","id");
--> statement-breakpoint
-- pgmq-managed table: index added manually (table created by pgmq.create() in 0018)
CREATE INDEX IF NOT EXISTS "q_consumer_job_queue_machine_id_consumer_name_idx"
  ON "pgmq"."q_consumer_job_queue" USING btree (("message"->'event_payload'->>'machineId'), ("message"->>'consumer_name'));
