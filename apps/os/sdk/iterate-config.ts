import type { ContextRule } from "../backend/agent/context.ts";

export type IterateConfig = {
  contextRules?: ContextRule[];
};

export function defineConfig(config: IterateConfig) {
  return config;
}
