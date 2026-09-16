/**
 * The project's root worker (`itx.worker`) and, through the rule `itx.voice ⇒ itx.worker`, what
 * a device calls on the button press:
 *
 *   await root.voice.setupVoiceAgent({ streamPath, activation })   // → { streamPath }
 *
 * ONE append on the conversation's fresh context: the two facet subscription rows (the voice
 * relay and the agent that answers its delegations — what `processors.enable` writes) and the
 * call's birth, so the relay materialises, reads `call-started` from its log and dials the provider
 * before the first microphone frame arrives. The device carries no source and no class name; the
 * bundles live in the project's KV.
 *
 * The funnel delivers every durable event of every context here too (`processEvent`); nothing
 * reacts today.
 */
import { ConfigWorker } from "./processor.js";

/* Replaced by the installer with the bundle's content hash (the agent facet's key is inlined at its
 * row below): the loader caches an isolate under the key, so a new build must be a new key. */
const VOICE_AGENT_CACHE_KEY = "voice-agent:dev";

export default class VoiceWorker extends ConfigWorker {
  async health(): Promise<{ ok: true; projectId: unknown; cacheKey: string }> {
    const itx = this.env.ITX.get() as unknown as { whoami(): Promise<{ projectId?: unknown }> };
    return { ok: true, projectId: (await itx.whoami()).projectId, cacheKey: VOICE_AGENT_CACHE_KEY };
  }

  /** The press. `activation` is the device's call identity: the call starts under it at boot and
   * the microphone frames carry it. */
  async setupVoiceAgent(options: {
    streamPath?: string;
    activation: string;
  }): Promise<{ streamPath: string }> {
    const streamPath = options.streamPath || `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(`voice streamPath must be absolute; received ${JSON.stringify(streamPath)}`);
    }
    const itx = this.env.ITX.get() as unknown as {
      cd(path: string): { append(...events: object[]): Promise<unknown> };
    };
    await itx.cd(streamPath).append(
      {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "voice-agent",
          target: [
            "itx",
            "builtins",
            "facets",
            [
              "get",
              "voice-agent",
              {
                source: "itx.kv.get('voice-agent.js')",
                cacheKey: VOICE_AGENT_CACHE_KEY,
                className: "VoiceAgentDurableObject",
              },
            ],
            "processEventBatch",
          ],
          /* Every durable event, plus the two ephemeral types a processor only sees by name. */
          consumes: [
            "*",
            "events.iterate.com/voice-agent/mic-frame",
            "events.iterate.com/voice-agent/keepalive",
          ],
        },
      },
      {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "agent",
          target: [
            "itx",
            "builtins",
            "facets",
            [
              "get",
              "agent",
              {
                source: "itx.kv.get('agent.js')",
                /* Substituted by the installer with agent.js's content hash, like the voice key. */
                cacheKey: "agent:dev",
                className: "AgentDurableObject",
              },
            ],
            "processEventBatch",
          ],
          /* The relay's delegations, and the agent's own answers (to settle the pending fold). */
          consumes: [
            "events.iterate.com/voice-agent/delegation-requested",
            "events.iterate.com/voice-agent/commentary",
          ],
        },
      },
      {
        type: "events.iterate.com/voice-agent/call-started",
        idempotencyKey: `voice-agent/call:${options.activation}`,
        payload: {
          activation: options.activation,
          conversationId: `conv_${options.activation}`,
        },
      },
    );
    return { streamPath };
  }
}
