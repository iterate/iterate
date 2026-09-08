import { voiceAgentEntrypointRef, type VoiceAgentRpc } from "@iterate-com/voice-agent";
import {
  IterateWorkerEntrypoint,
  type DynamicWorkerCapability,
  type StreamEvent,
} from "iterate/sdk";

// The voice agent is a guest worker: package.json declares
// @iterate-com/voice-agent and the platform builds it from node_modules on
// the first call into it. This project worker does not run the agent; the
// boards, the voicelab CLI and the mobile app address the guest directly
// through the package's worker refs. What it does is answer for the project
// and offer one route that pays for the guest's build on purpose.
export default class VoiceAgentProjectWorker extends IterateWorkerEntrypoint {
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
    if (new URL(req.url).pathname === "/voice/health") {
      // A dynamic worker is built lazily on the first call into it, so this
      // route is where a build failure surfaces on request rather than in a
      // conversation. The cast exists because workers.get hands back the
      // platform's generic handle; the guest's own methods are known only to
      // the package's types.
      using voiceAgent = this.itx.workers.get(
        voiceAgentEntrypointRef,
      ) as unknown as DynamicWorkerCapability<Pick<VoiceAgentRpc, "health">>;
      return Response.json(await voiceAgent.health());
    }
    return new Response(
      "This project runs the iterate voice agent as a guest worker. GET /voice/health builds and probes it.",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
}
