CREATE TABLE "slack_webhook_event" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"ts" text,
	"thread_ts" text,
	"channel" text,
	"type" text,
	"subtype" text,
	"user" text,
	"estate_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "channel_or_thread_messages" ON "slack_webhook_event" USING btree ("channel","ts","thread_ts","type");--> statement-breakpoint
CREATE INDEX "slack_webhook_event_estate_id_index" ON "slack_webhook_event" USING btree ("estate_id");