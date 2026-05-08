import { StreamPath } from "@iterate-com/shared/streams/types";

export function agentPathFromInput(value: string) {
  const relativePath = normalizeAgentRelativePath(value);
  if (!relativePath) throw new Error("Agent path must include a name.");
  return StreamPath.parse(`/agents/${relativePath}`);
}

export function agentPathFromSplat(value: string | undefined) {
  const relativePath = normalizeAgentRelativePath(value ?? "");
  if (!relativePath) throw new Error("Agent path must include a name.");
  return StreamPath.parse(`/agents/${relativePath}`);
}

export function agentPathToSplat(path: string) {
  const relativePath = normalizeAgentRelativePath(path);
  return relativePath || "default";
}

function normalizeAgentRelativePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withoutSlashes = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  if (withoutSlashes === "agents") return "";
  if (withoutSlashes.startsWith("agents/")) return withoutSlashes.slice("agents/".length);
  return withoutSlashes;
}
