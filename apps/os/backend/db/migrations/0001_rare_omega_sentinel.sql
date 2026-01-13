DROP INDEX "project_env_var_project_id_key_index";--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "external_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "project_env_var" ADD COLUMN "machine_id" text;--> statement-breakpoint
ALTER TABLE "project_env_var" ADD COLUMN "type" text DEFAULT 'user';--> statement-breakpoint
ALTER TABLE "project_env_var" ADD CONSTRAINT "project_env_var_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_var_project_id_machine_id_key_index" ON "project_env_var" USING btree ("project_id","machine_id","key");--> statement-breakpoint
CREATE INDEX "project_env_var_machine_id_index" ON "project_env_var" USING btree ("machine_id");