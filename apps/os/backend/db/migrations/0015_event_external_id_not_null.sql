DROP INDEX "event_type_external_id_unique";--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_type_external_id_unique" ON "event" USING btree ("type","external_id");