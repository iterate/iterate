CREATE TABLE "secret" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"project_id" text,
	"user_id" text,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"egress_proxy_rule" text,
	"metadata" jsonb,
	"last_success_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "secret_scope_key_idx" UNIQUE NULLS NOT DISTINCT("organization_id","project_id","user_id","key")
);
--> statement-breakpoint
ALTER TABLE "project_env_var" ADD COLUMN "value" text;--> statement-breakpoint
UPDATE "project_env_var" SET "value" = "encrypted_value";--> statement-breakpoint
ALTER TABLE "project_env_var" ALTER COLUMN "value" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "secret_organization_id_index" ON "secret" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "secret_project_id_index" ON "secret" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "secret_user_id_index" ON "secret" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "secret_key_index" ON "secret" USING btree ("key");--> statement-breakpoint
ALTER TABLE "project_env_var" DROP COLUMN "encrypted_value";