DROP INDEX "event_type_external_id_unique";--> statement-breakpoint
UPDATE "event" SET "external_id" = 'legacy:' || "id" WHERE "external_id" IS NULL;--> statement-breakpoint
ALTER TABLE "event" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_type_external_id_unique" ON "event" USING btree ("type","external_id");