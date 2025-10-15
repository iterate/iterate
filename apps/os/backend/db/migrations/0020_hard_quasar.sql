DROP INDEX "provider_user_mapping_provider_id_external_id_index";--> statement-breakpoint
ALTER TABLE "provider_user_mapping" ADD COLUMN "estate_id" text;--> statement-breakpoint
ALTER TABLE "provider_user_mapping" ADD COLUMN "external_user_team_id" text;--> statement-breakpoint
ALTER TABLE "provider_user_mapping" ADD CONSTRAINT "provider_user_mapping_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_user_mapping_provider_id_estate_id_external_id_index" ON "provider_user_mapping" USING btree ("provider_id","estate_id","external_id");