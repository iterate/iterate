/**
 * Default Iterate Configuration
 *
 * This is the default config used when no iterate.config.ts is found in the CWD.
 * Copy this file to your project root as `iterate.config.ts` and customize.
 *
 * See https://models.dev for available provider and model IDs.
 */
import { iterateConfig } from "@iterate-com/daemon/config/index.ts";

export default iterateConfig({
  /**
   * Default model used for OpenCode sessions.
   */
  defaultModel: () => {
    if (process.env.ANTHROPIC_API_KEY)
      return { providerID: "anthropic", modelID: "claude-opus-4-6" };
    return { providerID: "opencode", modelID: "kimi-k2.5-free" };
  },
});
