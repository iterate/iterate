import type { Stream } from "../../itx-api.generated.ts";
import { AGENT_SYSTEM_PROMPT_CONTEXT_KEY } from "../agents/agent-processor-contract.ts";

export const ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS = 90_000;

/** Birth policy and inbound messages are independent distributed reactions.
 * The agent reducer itself gates requests on this same keyed system item; the
 * explicit wait keeps policy propagation time outside ask()'s reply timeout. */
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
    eventTypes: ["events.iterate.com/agents/context-added"],
    predicate: (event) =>
      event.payload?.role === "system" && event.payload.key === AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
    timeoutMs: ASK_ASSISTANT_SESSION_READY_TIMEOUT_MS,
  });
}
