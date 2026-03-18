import { scriptCli } from "./_cli.ts";
import { checkMigrationIdsScript } from "./db/check-migration-ids.ts";
import { dumpSchemaScript } from "./db/dump-schema.ts";
import { previewSqlScript } from "./db/preview-sql.ts";
import { rebuildTempDbScript } from "./db/rebuild-temp-db.ts";

export const router = scriptCli.router({
  db: {
    tmp: {
      rebuild: rebuildTempDbScript,
      preview: previewSqlScript,
    },
    schema: {
      dump: dumpSchemaScript,
    },
    "check-migration-ids": checkMigrationIdsScript,
  },
});
