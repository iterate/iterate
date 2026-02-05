-- Migrate machine type 'local-docker' to 'docker'
-- This is part of the sandbox package refactoring to unify provider naming
UPDATE "machine" SET "type" = 'docker' WHERE "type" = 'local-docker';
