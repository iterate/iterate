// The facet composition's path→family selection, extracted pure so creation
// doors can refuse a path another family claims BEFORE committing a birth
// batch. A birth committed at a claimed path is a silent wedge: the batch
// (creation intent + facet subscription) lands, but the path's composition
// registers the CLAIMING family, the facet wake fails "unknown processor
// name" forever, and the creating caller hangs waiting for a terminal event
// that can never come. `ProcessorFacet.#registerProcessors`
// (processor-facet-durable-object.ts) dispatches on exactly this function, so
// the door-side guard and the composition can never drift.
import { AGENT_COLLECTION_PATH } from "./agents/agent-collection-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH } from "./email/utils.ts";
import { WORKSPACE_PATH_PREFIX } from "./workspaces/utils.ts";

/** One arm of the facet composition — the processor family a stream path hosts. */
type FacetProcessorFamily =
  | "project-root"
  | "agent-collection"
  | "agent"
  | "email-router"
  | "slack-router"
  | "telegram-router"
  | "device"
  | "secret"
  | "workspace"
  | "repo";

/**
 * Which processor family the facet composition registers at a stream path.
 * Repos are the ELSE arm, not a "/repos/" family: repos.get accepts any path
 * (the examples create repos under /examples/**), exactly as the retired Repo
 * Durable Object existed at every {projectId, path}. Only paths claimed by
 * another family cannot host a repo. Deployment-global streams (null
 * projectId) only ever host repos.
 */
export function facetProcessorFamilyForPath(input: {
  path: string;
  projectId: string | null;
}): FacetProcessorFamily {
  const { path, projectId } = input;
  if (!projectId) return "repo";
  if (path === "/") return "project-root";
  if (path === AGENT_COLLECTION_PATH) return "agent-collection";
  if (path.startsWith("/agents/")) return "agent";
  if (path === EMAIL_INTEGRATION_STREAM_PATH) return "email-router";
  if (path.startsWith("/integrations/slack/")) return "slack-router";
  if (path.startsWith("/integrations/telegram/")) return "telegram-router";
  if (path.startsWith("/devices/")) return "device";
  if (path.startsWith("/secrets/")) return "secret";
  if (path.startsWith(`${WORKSPACE_PATH_PREFIX}/`)) return "workspace";
  return "repo";
}
