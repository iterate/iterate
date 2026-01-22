#!/usr/bin/env tsx
/**
 * Sandbox Benchmark CLI
 *
 * Usage:
 *   tsx cli.ts build-images --config benchmark.config.ts
 *   tsx cli.ts run --config benchmark.config.ts
 *   tsx cli.ts cleanup --provider daytona
 */

import { resolve, dirname, basename } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BenchmarkConfig, BuildConfig, ImageRef, ProviderName } from "./config.ts";
import { runBenchmark, cleanupProvider } from "./runner/index.ts";
import { getProvider } from "./providers/index.ts";
import { generateReport } from "./analysis/report.ts";

const USAGE = `
Sandbox Benchmark CLI

Commands:
  build-images --config <file>     Build images for all providers
  run --config <file>              Run benchmark
  report --db <file> [--output <file>]  Generate HTML report
  cleanup --provider <name>        Cleanup orphaned sandboxes

Options:
  --config <file>    TypeScript config file (exports config or buildConfig)
  --db <file>        SQLite database file with benchmark results
  --output <file>    Output HTML file (default: reports/<db-name>.html)
  --provider <name>  Provider name (daytona, e2b, fly)

Examples:
  tsx cli.ts build-images --config benchmark-build.config.ts
  tsx cli.ts run --config benchmark.config.ts
  tsx cli.ts report --db results.db --output reports/my-report.html
  tsx cli.ts cleanup --provider daytona
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "build-images":
      await handleBuildImages(args.slice(1));
      break;

    case "run":
      await handleRun(args.slice(1));
      break;

    case "cleanup":
      await handleCleanup(args.slice(1));
      break;

    case "report":
      await handleReport(args.slice(1));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith("--")) {
        result[key] = value;
        i++;
      } else {
        result[key] = "true";
      }
    }
  }
  return result;
}

async function loadConfig<T>(configPath: string): Promise<T> {
  const absolutePath = resolve(process.cwd(), configPath);
  const fileUrl = pathToFileURL(absolutePath).href;

  console.log(`[cli] Loading config from: ${absolutePath}`);

  const module = await import(fileUrl);

  // Try common export names
  if (module.config) return module.config as T;
  if (module.buildConfig) return module.buildConfig as T;
  if (module.default) return module.default as T;

  throw new Error(`Config file must export 'config', 'buildConfig', or 'default'`);
}

async function handleBuildImages(args: string[]): Promise<void> {
  const parsedArgs = parseArgs(args);
  const configPath = parsedArgs.config;

  if (!configPath) {
    console.error("Error: --config is required");
    process.exit(1);
  }

  const absoluteConfigPath = resolve(process.cwd(), configPath);
  const configDir = dirname(absoluteConfigPath);
  const buildConfig = await loadConfig<BuildConfig>(configPath);

  console.log(`[cli] Building images for ${buildConfig.providers.length} providers`);
  console.log(`[cli] Dockerfiles: ${buildConfig.dockerfiles.map((d) => d.name).join(", ")}`);

  const images: Record<string, ImageRef> = {};

  // Build images for each provider/dockerfile combination in parallel
  const buildTasks: Promise<void>[] = [];

  for (const dockerfile of buildConfig.dockerfiles) {
    for (const providerName of buildConfig.providers) {
      buildTasks.push(
        (async () => {
          const key = `${providerName}-${dockerfile.name}`;
          console.log(`[cli] Building ${key}...`);

          try {
            const provider = getProvider(providerName);
            // Resolve dockerfile path relative to config file directory
            const dockerfilePath = resolve(configDir, dockerfile.path);
            const image = await provider.buildImage(dockerfilePath, dockerfile.name);
            images[key] = image;
            console.log(`[cli] Built ${key}: ${image.identifier}`);
          } catch (error) {
            console.error(`[cli] Failed to build ${key}:`, error);
            throw error;
          }
        })(),
      );
    }
  }

  await Promise.all(buildTasks);

  // Write output file (relative to cwd, not config file location)
  const outputPath = resolve(process.cwd(), buildConfig.outputFile);
  const outputContent = `/**
 * Generated benchmark images
 * Built at: ${new Date().toISOString()}
 */

import type { ImageRef } from "../config.ts";

export const images: Record<string, ImageRef> = ${JSON.stringify(images, null, 2)};
`;

  writeFileSync(outputPath, outputContent);
  console.log(`[cli] Wrote ${Object.keys(images).length} images to ${outputPath}`);
}

async function handleRun(args: string[]): Promise<void> {
  const parsedArgs = parseArgs(args);
  const configPath = parsedArgs.config;

  if (!configPath) {
    console.error("Error: --config is required");
    process.exit(1);
  }

  const config = await loadConfig<BenchmarkConfig>(configPath);

  console.log(`[cli] Starting benchmark run`);
  console.log(`[cli] Configs: ${config.configs.map((c) => c.name).join(", ")}`);
  console.log(`[cli] Machines per config: ${config.machinesPerConfig}`);
  console.log(`[cli] Requests per machine: ${config.requestsPerMachine}`);
  console.log(`[cli] Output: ${config.output}`);

  const runId = await runBenchmark(config);

  console.log(`[cli] Benchmark complete. Run ID: ${runId}`);
  console.log(`[cli] Results saved to: ${config.output}`);
}

async function handleCleanup(args: string[]): Promise<void> {
  const parsedArgs = parseArgs(args);
  const providerName = parsedArgs.provider as ProviderName | undefined;

  if (!providerName) {
    console.error("Error: --provider is required");
    process.exit(1);
  }

  if (!["daytona", "e2b", "fly"].includes(providerName)) {
    console.error(`Error: Unknown provider: ${providerName}`);
    process.exit(1);
  }

  console.log(`[cli] Cleaning up ${providerName} sandboxes...`);

  const deleted = await cleanupProvider(providerName);

  console.log(`[cli] Deleted ${deleted} sandboxes`);
}

async function handleReport(args: string[]): Promise<void> {
  const parsedArgs = parseArgs(args);
  const dbPath = parsedArgs.db;

  if (!dbPath) {
    console.error("Error: --db is required");
    process.exit(1);
  }

  // Default output: reports/<db-name>.html
  const dbName = basename(dbPath, ".db");
  const defaultOutput = `reports/${dbName}.html`;
  const outputPath = parsedArgs.output ?? defaultOutput;

  // Ensure reports directory exists
  const outputDir = dirname(resolve(process.cwd(), outputPath));
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    console.log(`[cli] Created directory: ${outputDir}`);
  }

  console.log(`[cli] Generating report from ${dbPath}...`);

  await generateReport(dbPath, outputPath);

  console.log(`[cli] Report generated: ${outputPath}`);
}

main().catch((error) => {
  console.error("[cli] Fatal error:", error);
  process.exit(1);
});
