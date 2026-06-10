import { os } from "@orpc/server";

// This router is only ever loaded from a repo checkout (via iterateAppCli.localRouterPaths),
// so it can reach into apps/os for scripts that depend on OS domain internals.
import { seedIterateConfigBaseRepoScript } from "../../../../apps/os/scripts/seed-iterate-config-base-repo.ts";
import { setupArtifactEventSubscriptionsScript } from "../../../../apps/os/scripts/setup-artifact-event-subscriptions.ts";
import { claudeMcpScript } from "./claude-mcp.ts";

export const router = os.router({
  artifacts: {
    "seed-config-base": seedIterateConfigBaseRepoScript,
    "setup-event-subscriptions": setupArtifactEventSubscriptionsScript,
  },
  "claude-mcp": claudeMcpScript,
});
