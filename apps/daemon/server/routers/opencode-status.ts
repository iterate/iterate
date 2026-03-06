import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2";

/**
 * Derive agent status from an OpenCode event. Returns null if the event is
 * irrelevant to agent lifecycle (e.g. message.updated, file.edited, etc.).
 */
export function agentStatusFromOpencodeEvent(
  event: OpencodeEvent,
): { isWorking: boolean; shortStatus: string } | null {
  // Idle / error -> not working
  if (
    event.type === "session.idle" ||
    event.type === "session.error" ||
    (event.type === "session.status" && event.properties.status.type === "idle")
  ) {
    return { isWorking: false, shortStatus: "" };
  }

  // Busy session -> thinking (LLM is reasoning, no tool call or text yet)
  if (event.type === "session.status" && event.properties.status.type === "busy") {
    return { isWorking: true, shortStatus: "🤔 Thinking" };
  }

  if (event.type === "message.part.updated") {
    // Text part -> the LLM is generating a response
    if (event.properties.part.type === "text") {
      return { isWorking: true, shortStatus: "✏️ Writing response" };
    }

    // Tool status -> working with a short description
    if (event.properties.part.type === "tool") {
      const { state } = event.properties.part;
      if (state.status !== "running" && state.status !== "completed") return null;

      const title = "title" in state && typeof state.title === "string" ? state.title : "";
      const description =
        state.input && typeof state.input.description === "string" ? state.input.description : "";
      const shortStatus = `🔧 ${(title || description || event.properties.part.tool || "Working").slice(0, 27)}`;
      return { isWorking: true, shortStatus };
    }
  }

  return null;
}

export function extractOpencodeSessionId(event: OpencodeEvent): string | null {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return null;
  }
}
