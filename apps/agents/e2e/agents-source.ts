// e2e/agents-source.ts — the agents app installed on a test root from @iterate-com/agents as this
// checkout has it (agents-workspace-config.ts), published as the project's config the one way
// there is: a commit to `/repos/config`.
import { installAgents } from "@iterate-com/agents/install";
import { olderSnapshotsExpired, publishConfig } from "../../os/e2e/support/client.ts";
import { agentsWorkspaceConfig } from "./agents-workspace-config.ts";

/** The app on `root` the way a project's config repo installs it: `agentsWorkspaceConfig` published
 *  as the project's config, whose `agents.ts` every facet of the app loads its class from
 *  (@iterate-com/agents install.ts `agentsFacetSpec`) by its identity in the manifest, then
 *  `installAgents`, as the init case calls it. The names it adds on the root answer in every other
 *  context once the snapshots of the root read before them have expired (context/rule-snapshots.ts):
 *  the publication had contexts read it, so a row waits that out before its agents act. */
export async function installWorkspaceAgents(root: Parameters<typeof installAgents>[0]) {
  await publishConfig(root, agentsWorkspaceConfig);
  await installAgents(root);
  await olderSnapshotsExpired();
}
