CREATE TABLE "estate_onboarding_event" (
	"id" text PRIMARY KEY NOT NULL,
	"estate_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"event_type" text NOT NULL,
	"category" text NOT NULL,
	"detail" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"task_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"processed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "estate_onboarding_event" ADD CONSTRAINT "estate_onboarding_event_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate_onboarding_event" ADD CONSTRAINT "estate_onboarding_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estate_onboarding_event_estate_id_event_type_index" ON "estate_onboarding_event" USING btree ("estate_id","event_type");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_estate_id_index" ON "estate_onboarding_event" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_estate_id_category_index" ON "estate_onboarding_event" USING btree ("estate_id","category");--> statement-breakpoint
CREATE INDEX "estate_onboarding_event_category_index" ON "estate_onboarding_event" USING btree ("category");--> statement-breakpoint
CREATE INDEX "system_tasks_processed_at_index" ON "system_tasks" USING btree ("processed_at");--> statement-breakpoint
CREATE INDEX "system_tasks_aggregate_type_index" ON "system_tasks" USING btree ("aggregate_type");--> statement-breakpoint
CREATE INDEX "system_tasks_aggregate_id_index" ON "system_tasks" USING btree ("aggregate_id");