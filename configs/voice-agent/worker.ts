import { VoiceAgentApp } from "@iterate-com/voice-agent";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

// The voice agent is a guest worker: voice-agent.ts beside this file names
// it, and the platform builds that file from @iterate-com/voice-agent. The
// boards, the voicelab CLI and the mobile app talk to the guest directly.
// VoiceAgentApp is the project worker's side of it: the voice app slug, and
// `setup` / `remove` for a line the project starts itself.
export default class VoiceAgentProjectWorker extends IterateWorkerEntrypoint {
  #voice = VoiceAgentApp.create(this.env);

  protected override async processEvent(event: StreamEvent): Promise<void> {
    if (
      event.type === "events.iterate.com/agent/created" &&
      event.source?.copiedFrom === undefined
    ) {
      // The platform births agents with a high (60s) debounce — the window
      // for this worker to configure them before their first turn. This
      // template keeps the platform defaults, so lowering the debounce back
      // to the ordinary 250ms is its whole birth reaction.
      await this.itx.agents.get(event.path).append({
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "iterate/config/agent-birth-configured:v1",
        payload: { config: { llmRequestDebounceMs: 250 } },
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    return (
      (await this.#voice.fetch(req)) ??
      new Response(
        "This project runs the iterate voice agent as a guest worker (voice-agent.ts).",
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      )
    );
  }
}
