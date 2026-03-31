import { scriptCli } from "../_cli.ts";
import { dumpSchemaFile, rebuildTempDb } from "../lib/db-utils.ts";

export const dumpSchemaScript = scriptCli
  .meta({
    default: true,
    description: "Write the derived sqlite schema snapshot for the service",
  })
  .handler(async () => {
    const dbPath = rebuildTempDb();
    const schemaPath = dumpSchemaFile(dbPath);

    return {
      dbPath,
      schemaPath,
    };
  });
