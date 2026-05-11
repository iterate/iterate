import { StreamPath } from "@iterate-com/shared/streams/types";

export function agentPathFromInput(value: string) {
  const path = StreamPath.parse(value.trim());
  if (!path.startsWith("/agents/")) {
    throw new Error("Agent path must start with /agents/.");
  }
  return path;
}
