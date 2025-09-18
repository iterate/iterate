CREATE TABLE "provider_estate_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"internal_estate_id" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_user_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"internal_user_id" text NOT NULL,
	"external_id" text NOT NULL,
	"provider_metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_estate_mapping_provider_id_external_id_index" ON "provider_estate_mapping" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_user_mapping_provider_id_external_id_index" ON "provider_user_mapping" USING btree ("provider_id","external_id");