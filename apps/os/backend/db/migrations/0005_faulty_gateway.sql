CREATE TABLE "iterate_config" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"estate_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
