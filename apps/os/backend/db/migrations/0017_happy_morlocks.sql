CREATE TABLE "slack_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"estate_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"is_ext_shared" boolean DEFAULT false NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_channel" ADD CONSTRAINT "slack_channel_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_channel_estate_id_external_id_index" ON "slack_channel" USING btree ("estate_id","external_id");--> statement-breakpoint
CREATE INDEX "slack_channel_estate_id_index" ON "slack_channel" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "slack_channel_name_index" ON "slack_channel" USING btree ("name");