import { pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { statSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tsImport } from "tsx/esm/api";
import { z } from "zod";
import { x as exec } from "tinyexec";
import { t } from "../config.ts";
import * as schema from "../../../backend/db/schema.ts";
import { createDb } from "../cli-db.ts";
import { workerCrons } from "../../../backend/worker-config.ts";
import { recentActiveSources } from "../../../backend/db/helpers.ts";
import { addSuperAdminUser } from "./admin.ts";

async function runBootstrap(configPath?: string) {
  // Hardcoding this so we never accidentally use the production db
  const connStr = `postgres://postgres:postgres@localhost:5432/iterate`;
  const db = createDb(connStr);

  // Always delete all iterate configs first
  await db.delete(schema.iterateConfig);

  await addSuperAdminUser(connStr);

  // If no config path provided, we're done
  if (!configPath) {
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
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });

  if (!resolvedPath) {
    throw new Error(
      `Could not find iterate config at any of these paths:\n${possiblePaths.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const configModule = (await tsImport(resolvedPath, {
    parentURL: pathToFileURL(resolvedPath).toString(),
  })) as { default?: any };

  // todo: rely on the build manager container to build in dev too. this is a partial recreation of what it does.
  const configDir = resolve(process.cwd(), dirname(resolvedPath));

  // Use git ls-files to get only tracked files (respects .gitignore automatically)
  const gitOutput = execSync(`git ls-files -- ${configDir}`, { cwd: configDir });
  const gitFiles = gitOutput.toString().trim().split("\n");

  const files = gitFiles.flatMap((file) => {
    if (!statSync(join(configDir, file)).isFile()) return [];
    const fullPath = join(configDir, file);
    const content = readFileSync(fullPath, "utf8");
    return [{ path: file, content }];
  });

  const config = configModule.default || configModule;

  if (!config) {
    throw new Error("No default export found in iterate config");
  }

  const installations = await db.query.installation.findMany({ with: recentActiveSources });

  // Insert the same config for all installations
  for (const installation of installations) {
    await db.transaction(async (tx) => {
      const [fakeBuild] = await tx
        .insert(schema.builds)
        .values({
          config: config,
          installationId: installation.id,
          commitHash: "dev",
          commitMessage: "dev",
          files,
          status: "complete",
          webhookIterateId: "dev",
          failureReason: null,
        })
        .returning();
      await tx.insert(schema.iterateConfig).values({
        installationId: installation.id,
        buildId: fakeBuild.id,
      });
    });
  }

  console.log(
    `Bootstrapped ${installations.length} installations' iterateConfig from ${resolvedPath}`,
  );
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

    setInterval(() => {
      const params = new URLSearchParams({ cron: workerCrons.processOutboxQueue });
      const url = `http://localhost:5173/cdn-cgi/handler/scheduled?${params.toString()}`;
      fetch(url).catch();
    }, 60_000);

    const result = await exec("doppler", ["run", "--", "vite", "dev"], {
      nodeOptions: {
        stdio: "inherit",
        cwd: process.cwd(),
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
