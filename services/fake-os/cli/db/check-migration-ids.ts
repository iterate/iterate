import { scriptCli } from "../_cli.ts";
import { assertUniqueMigrationIds } from "../lib/db-utils.ts";

export const checkMigrationIdsScript = scriptCli
  .meta({
    description: "Verify that committed migration timestamp prefixes are unique",
  })
  .handler(async () => {
    assertUniqueMigrationIds();

    return {
      ok: true,
      message: "fake-os migration ids are unique",
    };
  });
