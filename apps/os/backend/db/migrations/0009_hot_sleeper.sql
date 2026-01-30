CREATE TABLE "egress_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"policy_id" text,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"headers" jsonb NOT NULL,
	"body" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"session_id" text,
	"context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "egress_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"url_pattern" text,
	"method" text,
	"header_match" jsonb,
	"decision" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "egress_approval" ADD CONSTRAINT "egress_approval_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_approval" ADD CONSTRAINT "egress_approval_policy_id_egress_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."egress_policy"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_approval" ADD CONSTRAINT "egress_approval_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_policy" ADD CONSTRAINT "egress_policy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "egress_approval_project_id_status_index" ON "egress_approval" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "egress_approval_status_index" ON "egress_approval" USING btree ("status");--> statement-breakpoint
CREATE INDEX "egress_policy_project_id_priority_index" ON "egress_policy" USING btree ("project_id","priority");