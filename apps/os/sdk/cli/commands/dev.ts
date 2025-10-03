import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { x as exec } from "tinyexec";
import { t } from "../config.ts";
import * as schema from "../../../backend/db/schema.ts";

async function runBootstrap(configPath?: string) {
  try {
    if (!process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING) {
      throw new Error("DRIZZLE_RW_POSTGRES_CONNECTION_STRING is not set");
    }

    const pg = postgres(process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING, {
      max: 1,
      fetch_types: false,
    });

    const db = drizzle(pg, { schema, casing: "snake_case" });

    // If no config path provided, delete all iterate configs
    if (!configPath) {
      console.log("No iterate config path provided, deleting all iterate configs");

      await db.delete(schema.iterateConfig);

      console.log("All iterate configs deleted!");

      await pg.end();

      return {
        success: true,
        message: "Successfully deleted all iterate configs",
        deleted: true,
      };
    }

    // Path resolution strategy:
    // Try multiple possible locations for the config file
    const repoRoot = resolve(process.cwd(), "../..");
    const possiblePaths = [
      resolve(process.cwd(), configPath),
      resolve(process.cwd(), configPath, "iterate.config.ts"),
      resolve(repoRoot, configPath),
      resolve(repoRoot, configPath, "iterate.config.ts"),
    ];

    const resolvedPath = possiblePaths.find((path) => {
      return existsSync(path) && statSync(path).isFile();
    });

    if (!resolvedPath) {
      await pg.end();
      throw new Error(
        `Could not find iterate config at any of these paths:\n${possiblePaths.map((p) => `  - ${p}`).join("\n")}`,
      );
    }

    console.log(`Resolved config path: ${resolvedPath}`);

    const configModule = (await tsImport(resolvedPath, {
      parentURL: pathToFileURL(resolvedPath).toString(),
    })) as { default?: any };

    const config = configModule.default || configModule;

    if (!config) {
      await pg.end();
      throw new Error("No default export found in iterate config");
    }

    console.log("Loaded iterate config from: ", resolvedPath, config);

    const estates = await db.select().from(schema.estate);

    console.log(`Found ${estates.length} existing estates`);

    for (const estate of estates) {
      console.log(`Updating iterate config for estate: ${estate.name} (${estate.id})`);

      const existingConfig = await db
        .select()
        .from(schema.iterateConfig)
        .where(eq(schema.iterateConfig.estateId, estate.id))
        .limit(1);

      if (existingConfig.length > 0) {
        await db
          .update(schema.iterateConfig)
          .set({
            config: config,
            updatedAt: new Date(),
          })
          .where(eq(schema.iterateConfig.estateId, estate.id));

        console.log(`  ✓ Updated existing config`);
      } else {
        await db.insert(schema.iterateConfig).values({
          config: config,
          estateId: estate.id,
        });

        console.log(`  ✓ Created new config`);
      }
    }

    console.log("Bootstrap complete!");

    await pg.end();

    return {
      success: true,
      message: `Successfully bootstrapped ${estates.length} estates`,
      estatesUpdated: estates.length,
      skipped: false,
    };
  } catch (error) {
    console.error("Bootstrap failed:", error);
    throw error;
  }
}

const bootstrap = t.procedure
  .input(
    z.object({
      configPath: z.string().optional().describe("Path to iterate config file"),
    }),
  )
  .mutation(async ({ input }) => {
    return await runBootstrap(input.configPath);
  });

const start = t.procedure
  .input(
    z.object({
      config: z.string().optional().describe("Path to iterate config").meta({ alias: "c" }),
    }),
  )
  .mutation(async ({ input }) => {
    // Support both command-line flag and environment variable
    const providedConfigPath = input.config || process.env.ITERATE_CONFIG_PATH;

    if (providedConfigPath) {
      process.env.ITERATE_CONFIG_PATH = providedConfigPath;
      console.log(`Using iterate config: ${providedConfigPath}`);
    } else {
      console.log("No iterate config provided - will delete all configs");
    }

    console.log("Running estate bootstrap...");
    const bootstrapResult = await runBootstrap(providedConfigPath);
    console.log(bootstrapResult.message);

    console.log("Starting development server...");
    const result = await exec("doppler", ["run", "--", "react-router", "dev"], {
      nodeOptions: {
        stdio: "inherit",
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
          ...(providedConfigPath && { ITERATE_CONFIG_PATH: providedConfigPath }),
        },
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`Dev server failed with exit code ${result.exitCode}`);
    }

    return {
      success: true,
      message: "Dev server started successfully",
    };
  });

export const dev = t.router({
  bootstrap,
  start,
});
