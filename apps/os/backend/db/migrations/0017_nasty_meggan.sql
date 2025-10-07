-- Add 'external' to organization_user_membership role enum
ALTER TABLE "organization_user_membership" DROP CONSTRAINT IF EXISTS "organization_user_membership_role_check";
--> statement-breakpoint
ALTER TABLE "organization_user_membership" ADD CONSTRAINT "organization_user_membership_role_check" CHECK ("role" IN ('member', 'admin', 'owner', 'guest', 'external'));
--> statement-breakpoint
-- Create provider_channel_mapping table
CREATE TABLE "provider_channel_mapping" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"internal_estate_id" text NOT NULL,
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
ALTER TABLE "provider_channel_mapping" ADD CONSTRAINT "provider_channel_mapping_internal_estate_id_estate_id_fk" FOREIGN KEY ("internal_estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_channel_mapping_provider_id_external_id_index" ON "provider_channel_mapping" USING btree ("provider_id","external_id");--> statement-breakpoint
CREATE INDEX "provider_channel_mapping_internal_estate_id_index" ON "provider_channel_mapping" USING btree ("internal_estate_id");--> statement-breakpoint
CREATE INDEX "provider_channel_mapping_name_index" ON "provider_channel_mapping" USING btree ("name");