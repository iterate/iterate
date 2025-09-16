CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"filename" text,
	"file_size" integer,
	"mime_type" text,
	"open_ai_file_id" text,
	"uploaded_at" timestamp,
	"estate_id" text
);
