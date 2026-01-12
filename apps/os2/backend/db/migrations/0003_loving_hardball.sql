CREATE TABLE "daytona_preview_token" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"port" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daytona_preview_token" ADD CONSTRAINT "daytona_preview_token_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daytona_preview_token_machine_id_port_index" ON "daytona_preview_token" USING btree ("machine_id","port");--> statement-breakpoint
CREATE INDEX "daytona_preview_token_machine_id_index" ON "daytona_preview_token" USING btree ("machine_id");