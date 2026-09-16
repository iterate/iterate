/**
 * The project's `itx.voice`: what a device calls on the button press.
 *
 *   await root.voice.setupVoiceAgent({ streamPath })   // → { streamPath }
 *
 * A stateless worker the installer points `itx.voice` at (a rewrite rule on
 * the project root, `scripts/voice-install.ts`). It puts the voice facet and
 * its backend on the conversation's own context — two `processors.enable`
 * calls whose sources are the files the installer committed to the project's
 * config repo — so the device carries no source and no class names, only the
 * same `voice.setupVoiceAgent` call it made on apps/os.
 */
import { WorkerEntrypoint } from "cloudflare:workers";

/* Replaced by the installer with the committed sources' content hashes: the loader caches an
 * isolate under this key, so a new build must be a new key. */
const VOICE_AGENT_CACHE_KEY = "voice-agent:dev";
const VOICE_BACKEND_CACHE_KEY = "voice-backend:dev";

const T = "events.iterate.com/voice-agent/";

/** The voice facet's `consumes` — the contract's list in voice-agent.ts, which the subscription
 *  must name because ephemeral microphone frames reach a processor only by name. */
const VOICE_AGENT_CONSUMES = [
  `${T}created`,
  `${T}configured`,
  `${T}instructions`,
  `${T}thinking`,
  `${T}commentary`,
  `${T}call-started`,
  `${T}conversation-ended`,
  `${T}provider-error`,
  `${T}utterance-transcript`,
  `${T}answer-transcript`,
  `${T}mic-frame`,
  `${T}keepalive`,
];
const VOICE_BACKEND_CONSUMES = [
  `${T}delegation-requested`,
  "events.iterate.com/voice-backend/turn-settled",
];

type Itx = {
  whoami(): Promise<{ projectId?: string } & Record<string, unknown>>;
  cd(path: string): {
    processors: {
      enable(
        name: string,
        spec: { source: string; cacheKey: string; className: string; consumes: string[] },
      ): Promise<{ name: string }>;
    };
    append(
      ...events: { type: string; payload?: unknown; idempotencyKey?: string }[]
    ): Promise<unknown>;
  };
};

export default class VoiceSetup extends WorkerEntrypoint<{ ITX: { get(): Promise<Itx> } }> {
  async health(): Promise<{ ok: true; projectId: unknown; cacheKeys: string[] }> {
    const itx = await this.env.ITX.get();
    const who = await itx.whoami();
    return {
      ok: true,
      projectId: who.projectId,
      cacheKeys: [VOICE_AGENT_CACHE_KEY, VOICE_BACKEND_CACHE_KEY],
    };
  }

  async setupVoiceAgent(
    options: {
      streamPath?: string;
      instructions?: string;
      visemes?: boolean;
    } = {},
  ): Promise<{ streamPath: string }> {
    const streamPath = options.streamPath || `/agents/voice/${crypto.randomUUID()}`;
    if (!streamPath.startsWith("/")) {
      throw new Error(`voice streamPath must be absolute; received ${JSON.stringify(streamPath)}`);
    }
    const itx = await this.env.ITX.get();
    const call = itx.cd(streamPath);
    await Promise.all([
      call.processors.enable("voice-agent", {
        source: "itx.repos.readFile('config', 'voice-agent.js')",
        cacheKey: VOICE_AGENT_CACHE_KEY,
        className: "VoiceAgentDurableObject",
        consumes: VOICE_AGENT_CONSUMES,
      }),
      call.processors.enable("voice-backend", {
        source: "itx.repos.readFile('config', 'voice-backend.js')",
        cacheKey: VOICE_BACKEND_CACHE_KEY,
        className: "VoiceBackendDurableObject",
        consumes: VOICE_BACKEND_CONSUMES,
      }),
    ]);
    await call.append(
      {
        type: `${T}created`,
        idempotencyKey: `voice-agent/created:${streamPath}`,
        payload: {},
      },
      {
        type: `${T}configured`,
        idempotencyKey: `voice-agent/configured:${streamPath}`,
        payload: { instructions: options.instructions || "", visemes: options.visemes || false },
      },
    );
    return { streamPath };
  }
}
