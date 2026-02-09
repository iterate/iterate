import { tool, Plugin } from "@opencode-ai/plugin";

export default tool({
  description: "Get the current opencode session ID",
  args: {},
  async execute(_args, context) {
    return context.sessionID;
  },
});
