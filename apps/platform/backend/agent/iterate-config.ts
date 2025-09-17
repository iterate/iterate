import type { ContextRule } from "./context.ts";

export type IterateConfig = {
  /**
   * The name of your company or organization.
   * This is used to name your Iterate Estate
   */
  name: string;

  /**
   * The root domain of your iterate estate
   */
  rootDomain: string;

  /**
   * Context rules for your business - this is how you customize your agent
   */
  contextRules?: ContextRule[];

  /**
   * The path to your custom apps
   */
  _unstableApps?: any;
};

export function defineConfig(config: IterateConfig) {
  return config;
}
