// Agent paths are durable stream paths under /agents/**. The only hierarchy
// mechanics live here: resolving whether one agent should receive parent-agent
// prompt guidance when addressed below another agent path.

const PLATFORM_AGENT_NAMESPACES = new Set(["email", "mcp", "repos", "slack", "telegram", "web"]);

/**
 * The parent agent path for a child agent path, or null when the path is a
 * root-level agent or a platform-routed leaf agent. A manually addressed child
 * lives at `<parentAgentPath>/<name>`, so the immediate path parent decides
 * ownership and nesting recurses (`/agents/a/b/c` reports to `/agents/a/b`).
 *
 * Platform-routed agents also live under `/agents/**` (Slack threads, Telegram
 * chats, email threads, PRs, MCP sessions). Their route leaves are first-class
 * agents, not children of intermediate route segments; descendants beneath a
 * route leaf are ordinary child agents.
 *
 * This is intentionally not a listing mechanism. The only agent catalog is
 * `itx.agents.list()`; this helper is for prompt selection and avoiding
 * platform-route processors on child paths.
 */
export function childAgentParentPath(agentPath: string): string | null {
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
    case "web":
      return segments.length >= 3;
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
    case "web":
      return segments.length === 3;
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
