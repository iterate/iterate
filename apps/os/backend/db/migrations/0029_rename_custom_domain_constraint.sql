ALTER TABLE "project" DROP CONSTRAINT "project_custom_domain_unique";--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_customDomain_unique" UNIQUE("custom_domain");
