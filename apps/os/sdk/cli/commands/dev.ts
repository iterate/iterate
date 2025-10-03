import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod/v4";
import { x as exec } from "tinyexec";
import { t } from "../config.ts";
import * as schema from "../../../backend/db/schema.ts";

async function runBootstrap(configPath?: string) {
  if (!process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING) {
    throw new Error("DRIZZLE_RW_POSTGRES_CONNECTION_STRING is not set");
  }

  const pg = postgres(process.env.DRIZZLE_RW_POSTGRES_CONNECTION_STRING, {
    max: 1,
    fetch_types: false,
  });

  const db = drizzle(pg, { schema, casing: "snake_case" });

  // Always delete all iterate configs first
  await db.delete(schema.iterateConfig);
  console.log("Emptied iterate_config table ahead of bootstrap.");

  // If no config path provided, we're done
  if (!configPath) {
    await pg.end();
    console.log(
      "No iterate config path provided - estates will have an empty iterate config (like repo-less estates in production)",
    );
    return;
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

  const configModule = (await tsImport(resolvedPath, {
    parentURL: pathToFileURL(resolvedPath).toString(),
  })) as { default?: any };

  const config = configModule.default || configModule;

  if (!config) {
    await pg.end();
    throw new Error("No default export found in iterate config");
  }

  const estates = await db.select().from(schema.estate);

  // Insert the same config for all estates
  for (const estate of estates) {
    await db.insert(schema.iterateConfig).values({
      config: config,
      estateId: estate.id,
    });
  }

  await pg.end();

  console.log(`Bootstrapped ${estates.length} estates' iterateConfig from ${resolvedPath}`);
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

    await runBootstrap(providedConfigPath);

    const result = await exec("doppler", ["run", "--", "react-router", "dev"], {
      nodeOptions: {
        stdio: "inherit",
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
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
