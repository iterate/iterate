import { os } from "@orpc/server";
import { z } from "zod";

// This router is only ever loaded from a repo checkout (via iterateAppCli.localRouterPaths),
// so it can reach into apps/os for scripts that depend on OS domain internals.
import start, { attach, kill, restart, status } from "../../../../apps/os/scripts/dev.ts";
import { itxAgentSmokeScript } from "../../../../apps/os/scripts/itx-agent-smoke.ts";
import { itxRunScript } from "../../../../apps/os/scripts/itx-run.ts";
import { seedIterateConfigBaseRepoScript } from "../../../../apps/os/scripts/seed-iterate-config-base-repo.ts";
import { setupArtifactEventSubscriptionsScript } from "../../../../apps/os/scripts/setup-artifact-event-subscriptions.ts";
import { claudeMcpScript } from "./claude-mcp.ts";

const EmptyInput = z.object({});
const StartOptions = z.object({
  attach: z.boolean().optional(),
  detach: z.boolean().optional(),
  keepAlive: z.boolean().optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});

export const router = os.router({
  artifacts: {
    "seed-config-base": seedIterateConfigBaseRepoScript,
    "setup-event-subscriptions": setupArtifactEventSubscriptionsScript,
  },
  "claude-mcp": claudeMcpScript,
  dev: {
    attach: os
      .meta({ description: "Attach to the recorded OS local dev server log." })
      .input(EmptyInput)
      .handler(async () => attach()),
    kill: os
      .meta({ description: "Stop the recorded OS local dev server." })
      .input(EmptyInput)
      .handler(async () => kill()),
    restart: os
      .meta({ description: "Restart the OS local dev server." })
      .input(StartOptions)
      .handler(async ({ input }) => restart(input)),
    start: os
      .meta({
        default: true,
        description: "Start the OS local dev server, or attach if it is already running.",
      })
      .input(StartOptions)
      .handler(async ({ input }) => start(input)),
    status: os
      .meta({ description: "Show the recorded OS local dev server status." })
      .input(EmptyInput)
      .handler(async () => status()),
  },
  itx: {
    "agent-smoke": itxAgentSmokeScript,
    run: itxRunScript,
  },
});
