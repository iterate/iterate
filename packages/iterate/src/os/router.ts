import { os } from "@orpc/server";

// This router is only ever loaded from a repo checkout (via iterateAppCli.localRouterPaths),
// so it can reach into apps/os for scripts that depend on OS domain internals.
import { devServerScripts } from "../../../../apps/os/scripts/dev-server.ts";
import { itxAgentSmokeScript } from "../../../../apps/os/scripts/itx-agent-smoke.ts";
import { itxRunScript } from "../../../../apps/os/scripts/itx-run.ts";
import { seedIterateConfigBaseRepoScript } from "../../../../apps/os/scripts/seed-iterate-config-base-repo.ts";
import { setupArtifactEventSubscriptionsScript } from "../../../../apps/os/scripts/setup-artifact-event-subscriptions.ts";
import { claudeMcpScript } from "./claude-mcp.ts";

export const router = os.router({
  artifacts: {
    "seed-config-base": seedIterateConfigBaseRepoScript,
    "setup-event-subscriptions": setupArtifactEventSubscriptionsScript,
  },
  "claude-mcp": claudeMcpScript,
  dev: devServerScripts,
  itx: {
    "agent-smoke": itxAgentSmokeScript,
    run: itxRunScript,
  },
});
