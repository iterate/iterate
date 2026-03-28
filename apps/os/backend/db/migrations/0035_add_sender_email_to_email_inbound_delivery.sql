ALTER TABLE "email_inbound_delivery" ADD COLUMN "sender_email" text;--> statement-breakpoint
UPDATE "email_inbound_delivery"
SET "sender_email" = CASE
  WHEN "outbox_event"."payload"->'data'->>'from' LIKE '%<%>%'
    THEN substring("outbox_event"."payload"->'data'->>'from' FROM '<([^>]+)>')
  ELSE "outbox_event"."payload"->'data'->>'from'
END
FROM "outbox_event"
WHERE "outbox_event"."id" = "email_inbound_delivery"."outbox_event_id";--> statement-breakpoint
ALTER TABLE "email_inbound_delivery" ALTER COLUMN "sender_email" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "email_inbound_delivery_sender_email_project_id_status_index" ON "email_inbound_delivery" USING btree ("sender_email","project_id","status");
