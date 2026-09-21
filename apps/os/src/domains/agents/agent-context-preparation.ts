import { z } from "zod";
import type { EmittedInput } from "iterate/processors";
import { stringifyError, type AgentHost } from "./agent-host.ts";
import type { AgentProcessorContract } from "./agent-processor-contract.ts";

const PreparedContext = z.object({
  content: z.string().max(24_000),
  metadata: z.record(z.string(), z.unknown()),
});

/** The project callback is read-only. Its late result cannot append or start a turn. */
export async function prepareProjectContext(input: {
  host: AgentHost;
  preparation: { workerMethod: string[]; timeoutMs: number };
  messages: { role: string; content: string }[];
  triggerOffset: number;
}): Promise<EmittedInput<AgentProcessorContract>> {
  const started = input.host.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: "succeeded" | "failed" | "timed-out" = "succeeded";
  let content = "";
  let metadata: Record<string, unknown> = {};
  const timeout = new Error("Project context preparation timed out");
  try {
    const prepare = input.host.deps.prepareContext;
    if (!prepare) throw new Error("Project context preparation is not available on this host");
    const result = await Promise.race([
      prepare({
        workerMethod: input.preparation.workerMethod,
        agentPath: input.host.path,
        messages: input.messages,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout), input.preparation.timeoutMs);
      }),
    ]);
    ({ content, metadata } = PreparedContext.parse(result));
  } catch (error) {
    status = error === timeout ? "timed-out" : "failed";
    content =
      "Additional documentation could not be prepared for this message. Use the available documentation tools if needed.";
    metadata = { error: stringifyError(error) };
  } finally {
    clearTimeout(timer);
  }
  return {
    type: "events.iterate.com/agent/context-prepared",
    idempotencyKey: input.host.idempotencyKey(`context-prepared/${input.triggerOffset}`),
    payload: {
      triggerOffset: input.triggerOffset,
      status,
      content,
      metadata,
      durationMs: input.host.now() - started,
    },
  };
}
