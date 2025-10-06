import dedent from "dedent";
import { createDOToolFactory } from "../backend/agent/do-tools.ts";
import { iterateAgentTools } from "../backend/agent/iterate-agent-tools.ts";
import { slackAgentTools } from "../backend/agent/slack-agent-tools.ts";

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

export const tools = {
  ...createDOToolFactory(iterateAgentTools),
  ...createDOToolFactory(slackAgentTools),
};

export { tutorialRules } from "./tutorial.ts";
