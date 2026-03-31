import { scriptCli } from "../_cli.ts";
import { rebuildTempDb } from "../lib/db-utils.ts";

export const rebuildTempDbScript = scriptCli
  .meta({
    description: "Rebuild the temp sqlite database from committed migrations",
  })
  .handler(async () => {
    const dbPath = rebuildTempDb();

    return {
      dbPath,
    };
  });
