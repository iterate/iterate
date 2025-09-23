CREATE TABLE "dynamic_client_info" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_info" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dynamic_client_info_provider_id_client_id_index" ON "dynamic_client_info" USING btree ("provider_id","client_id");