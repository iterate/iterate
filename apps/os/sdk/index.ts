import dedent from "dedent";

export {
  contextRulesFromFiles,
  matchers,
  defineRule,
  defineRules,
} from "../backend/agent/context.ts";
export { defineConfig } from "./iterate-config.ts";
export { f } from "../backend/agent/prompt-fragments.ts";
export { dedent };

export type { ToolSpec } from "../backend/agent/tool-schemas.ts";
export type { PromptFragment } from "../backend/agent/prompt-fragments.ts";
export type { ContextRule } from "../backend/agent/context.ts";
