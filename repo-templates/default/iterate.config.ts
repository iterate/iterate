/**
 * Default Iterate Configuration
 *
 * This is the default config used when no iterate.config.ts is found in the CWD.
 * Copy this file to your project root as `iterate.config.ts` and customize.
 *
 * Model identifiers use the Models.dev format: "provider/model"
 * See https://models.dev for the full list of supported models.
 */
import { iterateConfig } from "@iterate-com/daemon/config/index.ts";

export default iterateConfig({
  /**
   * Default model used for OpenCode sessions.
   * Uses Models.dev format: "provider/model"
   * Examples: "anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.0-flash"
   */
  defaultModel: "anthropic/claude-sonnet-4-5",
});
