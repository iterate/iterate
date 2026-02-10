#!/usr/bin/env tsx
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DaytonaProvider } from "./providers/daytona.ts";
import { DockerProvider } from "./providers/docker.ts";
import { FlyProvider } from "./providers/fly.ts";
import type { ObservabilityProvider } from "./providers/types.ts";
import { findFlyDir, nowTag } from "./run-observability-lib.ts";
import { runScenario } from "./scenario.ts";

type RunnerConfig = {
  flyDir: string;
  artifactDir: string;
  app: string;
  backend: "docker" | "fly" | "daytona";
  cleanupOnExit: boolean;
  targetUrl: string;
  blockedUrl: string;
};

function buildConfig(): RunnerConfig {
  const flyDir = findFlyDir();
  const requested = process.env["E2E_BACKEND"]?.trim();
  const backend = requested === "fly" || requested === "daytona" ? requested : "docker";
  const app = process.env["APP_NAME"] ?? `iterate-obsv-${backend}-${nowTag()}`;
  const cleanupOnExit = process.env["E2E_CLEANUP_ON_EXIT"] !== "0";
  const targetUrl = process.env["TARGET_URL"] ?? "https://example.com/";
  const blockedUrl = process.env["BLOCKED_URL"] ?? "https://iterate.com/";
  const artifactDir = join(flyDir, "proof-logs", app);
  mkdirSync(artifactDir, { recursive: true });

  return {
    flyDir,
    artifactDir,
    app,
    backend,
    cleanupOnExit,
    targetUrl,
    blockedUrl,
  };
}

function makeLogger(summaryPath: string): (line: string) => void {
  return (line: string): void => {
    process.stdout.write(`${line}\n`);
    appendFileSync(summaryPath, `${line}\n`);
  };
}

function createProvider(config: RunnerConfig, log: (line: string) => void): ObservabilityProvider {
  const init = {
    flyDir: config.flyDir,
    app: config.app,
    cleanupOnExit: config.cleanupOnExit,
    targetUrl: config.targetUrl,
    log,
  };

  if (config.backend === "fly") return new FlyProvider(init);
  if (config.backend === "daytona") return new DaytonaProvider(init);
  return new DockerProvider(init);
}

export async function runObservability(): Promise<void> {
  const config = buildConfig();
  const summaryPath = join(config.artifactDir, "summary.txt");
  const log = makeLogger(summaryPath);
  const provider = createProvider(config, log);

  log(`Backend: ${config.backend}`);
  log(`App: ${config.app}`);
  log(`Target URL: ${config.targetUrl}`);
  log(`Blocked URL: ${config.blockedUrl}`);

  await runScenario(provider, {
    artifactDir: config.artifactDir,
    targetUrl: config.targetUrl,
    blockedUrl: config.blockedUrl,
    log,
  });
}

void runObservability().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
