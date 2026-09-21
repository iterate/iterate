import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { prepareDocumentation } from "./documentation.ts";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  get documentation() {
    return {
      prepare: async (input: {
        agentPath: string;
        messages: { role: string; content: string }[];
      }) =>
        prepareDocumentation(
          this.itx.scope({ path: input.agentPath, surface: ["docs"] }),
          this.itx.ai,
          input.messages,
        ),
    };
  }

  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (event.type !== "events.iterate.com/agent/created" || event.source?.copiedFrom) return;
    await this.itx.agents.get(event.path).append({
      type: "events.iterate.com/agent/configured",
      idempotencyKey: "jev-docs/configured:v1",
      payload: {
        config: {
          contextPreparation: {
            workerMethod: ["documentation", "prepare"],
            timeoutMs: 10_000,
          },
          llmRequestDebounceMs: 250,
        },
      },
    });
  }

  async fetch(): Promise<Response> {
    return new Response(
      "Jev docs experiment: send an agent a message in the normal Iterate chat. Selected documentation appears in its first LLM request; context-prepared events record sources, scores and timing.",
    );
  }
}
