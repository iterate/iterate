/**
 * Human-readable title (+ optional subtitle) when the agent has not set
 * status.title. Path shape is the source of truth for PR / review agents that
 * predate a status stamp, so the sidebar never falls back to a truncated
 * `repos/g~…/pull-requests/…` hash path.
 */
export function agentPathLabel(path: string): { title: string; subtitle?: string } {
  const segments = path.split("/").filter(Boolean);
  // /agents/repos/<id>/pull-requests/<n>/iterate-reviews/<checkId>
  if (
    segments[0] === "agents" &&
    segments[1] === "repos" &&
    segments[3] === "pull-requests" &&
    segments[5] === "iterate-reviews" &&
    segments[4] !== undefined &&
    segments[6] !== undefined
  ) {
    return {
      title: `PR #${segments[4]} review`,
      subtitle: `Check ${segments[6]}`,
    };
  }
  // /agents/repos/<id>/pull-requests/<n>
  if (
    segments[0] === "agents" &&
    segments[1] === "repos" &&
    segments[3] === "pull-requests" &&
    segments[4] !== undefined
  ) {
    return {
      title: `PR #${segments[4]}`,
      subtitle: "Pull request agent",
    };
  }
  // /agents/slack|email|telegram|…
  if (segments[0] === "agents" && segments.length > 1) {
    return { title: segments.slice(1).join("/") };
  }
  return { title: path };
}

/** Builtin icon inferred from the agent path when status.icon is unset. */
export function agentPathIcon(path: string): string | undefined {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "agents") return undefined;
  if (segments[1] === "repos" && segments[3] === "pull-requests") return "github";
  if (segments[1] === "slack") return "slack";
  if (segments[1] === "email") return "email";
  if (segments[1] === "telegram") return "telegram";
  if (segments[1] === "onboarding" || segments[1] === "mcp") return "web";
  return undefined;
}
