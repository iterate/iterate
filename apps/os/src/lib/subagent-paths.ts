// Subagents are ordinary agents whose streams are direct descendants of their
// parent agent's path: `<parentAgentPath>/<name>`. Being a subagent is a
// property of WHERE the stream sits — this module is the one path predicate
// everything derives it from (birth mechanics, default policy, the RPC doors,
// the UI). It lives in lib/ (not domains/agents/utils.ts) so client routes can
// import it without pulling server config into the browser bundle.

const PLATFORM_AGENT_NAMESPACES = new Set(["email", "mcp", "repos", "slack", "telegram"]);

/**
 * The parent agent path of a subagent path, or null when the path is not a
 * subagent. A subagent lives at `<parentAgentPath>/<name>`, so the immediate
 * path parent decides ownership and nesting recurses (the parent of
 * `/agents/a/b/c` is `/agents/a/b`). The parent must itself be an agent path,
 * so `/agents/x` — whose parent would be the `/agents` directory — is not a
 * subagent.
 *
 * Platform-owned routed agents also live under `/agents/**` (Slack threads,
 * Telegram chats, email threads, PRs, MCP sessions). Those route leaves are
 * not subagents, but descendants beneath a route leaf are: a Slack thread at
 * `/agents/slack/main/C1/ts-1` can delegate to `/agents/slack/main/C1/ts-1/helper`.
 *
 * A multi-segment relative path implies intermediate streams (spawning
 * `team/researcher` announces `/agents/main/team` too), and those
 * intermediates are subagents by this rule. Addresses are paths, not names.
 */
export function subagentParentPath(agentPath: string): string | null {
  const segments = agentPath.split("/").filter(Boolean);
  if (segments[0] !== "agents" || segments.length < 3) return null;
  if (isPlatformRouteLeaf(segments)) return null;

  const parentSegments = segments.slice(0, -1);
  if (!isAgentPathThatCanHaveChildren(parentSegments)) return null;
  return `/${parentSegments.join("/")}`;
}

function isAgentPathThatCanHaveChildren(segments: string[]): boolean {
  if (segments[0] !== "agents" || segments.length < 2) return false;
  const namespace = segments[1]!;
  if (!PLATFORM_AGENT_NAMESPACES.has(namespace)) return true;
  return hasPlatformRouteLeafPrefix(segments);
}

function hasPlatformRouteLeafPrefix(segments: string[]): boolean {
  switch (segments[1]) {
    case "email":
      return segments.length >= 3 && /^t[a-z0-9-]+$/i.test(segments[2]!);
    case "mcp":
      return segments.length >= 3;
    case "repos":
      return isPrRouteLeafPrefix(segments);
    case "slack":
      return segments.length >= 5 && segments[4]!.startsWith("ts-");
    case "telegram":
      return isTelegramRouteLeafPrefix(segments);
    default:
      return false;
  }
}

function isPlatformRouteLeaf(segments: string[]): boolean {
  switch (segments[1]) {
    case "email":
      return segments.length === 3 && /^t[a-z0-9-]+$/i.test(segments[2]!);
    case "mcp":
      return segments.length === 3;
    case "repos":
      return isPrRouteLeafPrefix(segments) && segments.length === 5;
    case "slack":
      return segments.length === 5 && segments[4]!.startsWith("ts-");
    case "telegram":
      return (
        isTelegramRouteLeafPrefix(segments) && telegramRouteLeafLength(segments) === segments.length
      );
    default:
      return false;
  }
}

function isPrRouteLeafPrefix(segments: string[]): boolean {
  return (
    segments.length >= 5 &&
    segments[1] === "repos" &&
    segments[3] === "pull-requests" &&
    /^\d+$/.test(segments[4]!)
  );
}

function isTelegramRouteLeafPrefix(segments: string[]): boolean {
  return telegramRouteLeafLength(segments) !== null;
}

function telegramRouteLeafLength(segments: string[]): number | null {
  if (segments.length < 4 || segments[1] !== "telegram" || !segments[3]!.startsWith("chat-")) {
    return null;
  }
  if (segments.length === 4) return 4;
  if (segments[4]!.startsWith("session-")) return 5;
  if (!segments[4]!.startsWith("topic-")) return 4;
  if (segments.length >= 6 && segments[5]!.startsWith("session-")) return 6;
  return 5;
}
