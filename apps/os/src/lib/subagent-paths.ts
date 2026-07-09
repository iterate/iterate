// Subagents are ordinary agents whose streams nest under their parent agent's
// path: `<parentAgentPath>/subagents/<name>`. Being a subagent is a property
// of WHERE the stream sits — this module is the one path predicate everything
// derives it from (birth mechanics, default policy, the RPC doors, the UI).
// It lives in lib/ (not domains/agents/utils.ts) so client routes can import
// it without pulling server config into the browser bundle.

export const SUBAGENTS_PATH_SEGMENT = "subagents";

/**
 * The parent agent path of a subagent path, or null when the path is not a
 * subagent. A subagent lives at `<parentAgentPath>/subagents/<relative path>`
 * — the relative part is an ordinary path and may have several segments. The
 * LAST `/subagents/` marker decides the parent, so nesting recurses (the
 * parent of `/agents/a/subagents/b/subagents/c` is `/agents/a/subagents/b`),
 * and the parent must itself be an agent path, so `/agents/subagents/x` —
 * whose "parent" would be the `/agents` directory — is not a subagent.
 *
 * A multi-segment relative path implies intermediate streams (spawning
 * `team/researcher` announces `…/subagents/team` too), and those
 * intermediates are subagents of the same parent by this rule — deliberate:
 * every intermediate under `/agents/**` is already an agent stream today
 * (`/agents/slack/main` gets agent mechanics), they just never run without
 * inputs. Addresses are paths, not names; the folder is part of the address.
 */
export function subagentParentPath(agentPath: string): string | null {
  const marker = `/${SUBAGENTS_PATH_SEGMENT}/`;
  const markerIndex = agentPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  if (agentPath.slice(markerIndex + marker.length) === "") return null;
  const parentPath = agentPath.slice(0, markerIndex);
  return parentPath.startsWith("/agents/") ? parentPath : null;
}
