import { scriptCli } from "../_cli.ts";
import { previewSchemaDiff, rebuildTempDb } from "../lib/db-utils.ts";

export const previewSqlScript = scriptCli
  .meta({
    description: "Preview the Drizzle schema diff against a temp sqlite database",
  })
  .handler(async () => {
    const dbPath = rebuildTempDb();
    previewSchemaDiff(dbPath);

    return {
      dbPath,
      previewed: true,
    };
  });
