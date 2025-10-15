CREATE TABLE "slack_channel_estate_override" (
	"id" text PRIMARY KEY NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_team_id" text NOT NULL,
	"estate_id" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_channel_estate_override" ADD CONSTRAINT "slack_channel_estate_override_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channel_estate_override_slack_channel_id_slack_team_id_index" ON "slack_channel_estate_override" USING btree ("slack_channel_id","slack_team_id");--> statement-breakpoint
CREATE INDEX "slack_channel_estate_override_slack_channel_id_index" ON "slack_channel_estate_override" USING btree ("slack_channel_id");--> statement-breakpoint
CREATE INDEX "slack_channel_estate_override_estate_id_index" ON "slack_channel_estate_override" USING btree ("estate_id");