DROP INDEX "dynamic_client_info_provider_id_client_id_index";--> statement-breakpoint
ALTER TABLE "dynamic_client_info" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "dynamic_client_info_provider_id_user_id_index" ON "dynamic_client_info" USING btree ("provider_id","user_id");