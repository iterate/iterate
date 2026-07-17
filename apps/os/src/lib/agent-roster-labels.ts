/** Human-readable title (+ optional subtitle) when status.title is unset. */
export function agentPathLabel(path: string): { title: string; subtitle?: string } {
  const segments = path.split("/").filter(Boolean);
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
  if (segments[1] === "slack") return "slack";
  if (segments[1] === "email") return "email";
  if (segments[1] === "telegram") return "telegram";
  if (segments[1] === "onboarding" || segments[1] === "mcp") return "web";
  return undefined;
}
