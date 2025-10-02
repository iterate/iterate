#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tsImport } from "tsx/esm/api";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../backend/db/schema.js";

async function bootstrap() {
  // Check for config path from environment variable
  const iterateConfigPath = process.env.ITERATE_CONFIG_PATH;

  // Connect to the database - use same connection as drizzle config
  const connectionString = "postgres://postgres:postgres@localhost:5432/iterate";

  const pg = postgres(connectionString, {
    max: 1,
    fetch_types: false,
  });

  const db = drizzle(pg, { schema, casing: "snake_case" });

  if (!iterateConfigPath) {
    console.log("No iterate config path provided, clearing all configs");

    try {
      // Delete all iterate configs
      await db.delete(schema.iterateConfig);
      console.log("✓ Cleared all iterate configs");

      await pg.end();
      return;
    } catch (error) {
      console.error("Failed to clear configs:", error);
      await pg.end();
      process.exit(1);
    }
  }

  try {
    // Resolve relative paths from the repository root (two levels up from apps/os)
    const repoRoot = resolve(process.cwd(), "../..");
    const resolvedPath = resolve(repoRoot, iterateConfigPath);
    console.log(`Resolved config path: ${resolvedPath}`);

    // Import the iterate config module
    const configModule = (await tsImport(resolvedPath, {
      parentURL: pathToFileURL(resolvedPath).toString(),
    })) as { default?: any };

    const config = configModule.default || configModule;

    if (!config) {
      throw new Error("No default export found in iterate config");
    }

    console.log("Loaded iterate config from: ", resolvedPath, config);

    // Load all existing estates
    const estates = await db.select().from(schema.estate);

    console.log(`Found ${estates.length} existing estates`);

    // Insert or update the iterate config for each estate
    for (const estate of estates) {
      console.log(`Updating iterate config for estate: ${estate.name} (${estate.id})`);

      // Check if a config already exists for this estate
      const existingConfig = await db
        .select()
        .from(schema.iterateConfig)
        .where(eq(schema.iterateConfig.estateId, estate.id))
        .limit(1);

      if (existingConfig.length > 0) {
        // Update existing config
        await db
          .update(schema.iterateConfig)
          .set({
            config: config,
            updatedAt: new Date(),
          })
          .where(eq(schema.iterateConfig.estateId, estate.id));

        console.log(`  ✓ Updated existing config`);
      } else {
        // Insert new config
        await db.insert(schema.iterateConfig).values({
          config: config,
          estateId: estate.id,
        });

        console.log(`  ✓ Created new config`);
      }
    }

    console.log("Bootstrap complete!");

    // TODO: Implement polling or file watching mechanism to detect:
    // - New accounts being created
    // - New estates being created
    // - Changes to the iterate config file
    // This would allow automatic updates without restarting the dev server

    // Close the database connection
    await pg.end();
  } catch (error) {
    console.error("Bootstrap failed:", error);
    process.exit(1);
  }
}

// Run the bootstrap
bootstrap().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
