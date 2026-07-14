import type { Stream } from "../../itx-api.generated.ts";

export const ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS = 90_000;

export async function ensureMcpSessionAgentReady(input: {
  agentPath: string;
  projectItx: {
    streams: {
      get(path: string): Pick<Stream, "append" | "waitForEvent">;
    };
  };
}): Promise<void> {
  const stream = input.projectItx.streams.get(input.agentPath);
  await stream.append({
    type: "events.iterate.com/mcp/session-agent-warmup",
    idempotencyKey: `mcp/session-agent-warmup:${input.agentPath}`,
    payload: { agentPath: input.agentPath },
  });
  await stream.waitForEvent({
    afterOffset: 0,
    eventTypes: ["events.iterate.com/agent/system-prompt-updated"],
    timeoutMs: ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS,
  });
}
