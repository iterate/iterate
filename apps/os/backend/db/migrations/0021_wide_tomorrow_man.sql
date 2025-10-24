CREATE TABLE "estate_onboarding" (
	"id" text PRIMARY KEY NOT NULL,
	"estate_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estate_onboarding_event" (
	"id" text PRIMARY KEY NOT NULL,
	"onboarding_id" text NOT NULL,
	"event_type" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"detail" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estate_onboarding" ADD CONSTRAINT "estate_onboarding_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate_onboarding" ADD CONSTRAINT "estate_onboarding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate_onboarding" ADD CONSTRAINT "estate_onboarding_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate_onboarding_event" ADD CONSTRAINT "estate_onboarding_event_onboarding_id_estate_onboarding_id_fk" FOREIGN KEY ("onboarding_id") REFERENCES "public"."estate_onboarding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estate_onboarding_estate_id_index" ON "estate_onboarding" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "estate_onboarding_state_index" ON "estate_onboarding" USING btree ("state");--> statement-breakpoint
CREATE INDEX "estate_onboarding_created_at_index" ON "estate_onboarding" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "estate_onboarding_event_onboarding_id_event_type_index" ON "estate_onboarding_event" USING btree ("onboarding_id","event_type");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_onboarding_id_index" ON "estate_onboarding_event" USING btree ("onboarding_id");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_onboarding_id_category_status_index" ON "estate_onboarding_event" USING btree ("onboarding_id","category","status");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_category_status_index" ON "estate_onboarding_event" USING btree ("category","status");