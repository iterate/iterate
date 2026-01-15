/**
 * Iterate CLI
 *
 * Built with trpc-cli - turn tRPC routers into CLIs
 *
 * Commands:
 *   daemon <procedure>     - Daemon tRPC procedures (listAgents, startAgent, etc.)
 *   agents <action>        - Agent management (list, get, start, stop)
 *   tool <action>          - Tool invocations (sendSlackMessage, sendEmail)
 */
import { createCli } from "trpc-cli";
import { router } from "./router.ts";

export const cli = createCli({
  router,
  name: "iterate",
  version: "0.0.1",
  description: "Iterate CLI - Daemon and agent management",
});
