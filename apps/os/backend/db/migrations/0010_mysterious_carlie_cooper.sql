CREATE TABLE "mcp_connection_param" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_key" text NOT NULL,
	"estate_id" text NOT NULL,
	"param_key" text NOT NULL,
	"param_value" text NOT NULL,
	"param_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connection_param_estate_id_connection_key_param_key_param_type_index" ON "mcp_connection_param" USING btree ("estate_id","connection_key","param_key","param_type");--> statement-breakpoint
CREATE INDEX "mcp_connection_param_estate_id_index" ON "mcp_connection_param" USING btree ("estate_id");--> statement-breakpoint
CREATE INDEX "mcp_connection_param_connection_key_index" ON "mcp_connection_param" USING btree ("connection_key");