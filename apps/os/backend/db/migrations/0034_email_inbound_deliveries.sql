CREATE TABLE "email_inbound_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"external_id" text NOT NULL,
	"outbox_event_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"project_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_inbound_delivery" ADD CONSTRAINT "email_inbound_delivery_outbox_event_id_outbox_event_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."outbox_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_inbound_delivery" ADD CONSTRAINT "email_inbound_delivery_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_inbound_delivery_provider_external_id_index" ON "email_inbound_delivery" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "email_inbound_delivery_project_id_status_index" ON "email_inbound_delivery" USING btree ("project_id","status");