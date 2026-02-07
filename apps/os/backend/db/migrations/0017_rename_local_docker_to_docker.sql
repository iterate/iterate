-- Migrate machine type 'local-docker' to 'docker'
UPDATE "machine" SET "type" = 'docker' WHERE "type" = 'local-docker';
