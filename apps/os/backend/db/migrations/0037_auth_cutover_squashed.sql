ALTER TABLE "device_code" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_invite" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "better_auth_session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "device_code" CASCADE;--> statement-breakpoint
DROP TABLE "organization_invite" CASCADE;--> statement-breakpoint
DROP TABLE "better_auth_session" CASCADE;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "auth_organization_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "auth_project_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_authOrganizationId_unique" UNIQUE("auth_organization_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_authProjectId_unique" UNIQUE("auth_project_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_authUserId_unique" UNIQUE("auth_user_id");