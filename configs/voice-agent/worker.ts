import { VoiceAgentApp } from "@iterate-com/voice-agent";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";

// The voice agent is a guest worker: package.json declares
// @iterate-com/voice-agent and the platform builds it from node_modules on
// the first call into it. The boards, the voicelab CLI and the mobile app
// address the guest directly; this project worker only needs to when it
// wants to — VoiceAgentApp gives it the guest's methods, typed.
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
    // A dynamic worker is built lazily on the first call into it, so this
    // route is where a build failure surfaces on request rather than in a
    // conversation.
    if (new URL(req.url).pathname === "/voice/health") {
      return Response.json(await this.#voice.health());
    }
    return new Response(
      "This project runs the iterate voice agent as a guest worker. GET /voice/health builds and probes it.",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
