DROP INDEX "project_connection_provider_external_id_index";--> statement-breakpoint
CREATE UNIQUE INDEX "project_connection_provider_external_id_idx" ON "project_connection" USING btree ("provider","external_id") WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "project_connection_user_provider_project_idx" ON "project_connection" USING btree ("project_id","provider","user_id") WHERE scope = 'user';--> statement-breakpoint
CREATE INDEX "project_connection_user_id_index" ON "project_connection" USING btree ("user_id");