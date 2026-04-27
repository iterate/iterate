ALTER TABLE "device_code" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_invite" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_user_membership" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "better_auth_session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "device_code" CASCADE;--> statement-breakpoint
DROP TABLE "organization_invite" CASCADE;--> statement-breakpoint
DROP TABLE "organization_user_membership" CASCADE;--> statement-breakpoint
DROP TABLE "better_auth_session" CASCADE;--> statement-breakpoint
ALTER TABLE "billing_account" RENAME COLUMN "organization_id" TO "auth_organization_id";--> statement-breakpoint
ALTER TABLE "project" RENAME COLUMN "organization_id" TO "auth_organization_id";--> statement-breakpoint
ALTER TABLE "billing_account" DROP CONSTRAINT "billing_account_organizationId_unique";--> statement-breakpoint
ALTER TABLE "secret" DROP CONSTRAINT "secret_scope_key_idx";--> statement-breakpoint
ALTER TABLE "billing_account" DROP CONSTRAINT "billing_account_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "secret" DROP CONSTRAINT "secret_organization_id_organization_id_fk";
--> statement-breakpoint
DROP INDEX "project_organization_id_name_index";--> statement-breakpoint
DROP INDEX "secret_organization_id_index";--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "auth_project_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "auth_organization_slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
CREATE INDEX "billing_account_auth_organization_id_index" ON "billing_account" USING btree ("auth_organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_auth_organization_id_name_index" ON "project" USING btree ("auth_organization_id","name");--> statement-breakpoint
CREATE INDEX "project_auth_organization_id_index" ON "project" USING btree ("auth_organization_id");--> statement-breakpoint
ALTER TABLE "secret" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "billing_account" ADD CONSTRAINT "billing_account_authOrganizationId_unique" UNIQUE("auth_organization_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_authProjectId_unique" UNIQUE("auth_project_id");--> statement-breakpoint
ALTER TABLE "secret" ADD CONSTRAINT "secret_scope_key_idx" UNIQUE NULLS NOT DISTINCT("project_id","user_id","key");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_authUserId_unique" UNIQUE("auth_user_id");
--> statement-breakpoint
DROP TABLE "organization" CASCADE;
