import type { ManagerConfig } from "./manager.ts";

export function defineConfig(config: ManagerConfig) {
  return config;
}

export * from "./restarting-process.ts";
export * from "./cron-process.ts";
export * from "./task-list.ts";
export * from "./lazy-process.ts";
export * from "./env-manager.ts";
export * from "./logger.ts";
export * from "./manager.ts";
