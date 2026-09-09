import { voiceAgentEntrypointRef } from "./ref.ts";
import type {
  SayOptions,
  SayResult,
  SetupVoiceAgentOptions,
  SetupVoiceAgentResult,
  VoiceAgentRpc,
} from "./setup-options.ts";

/**
 * The slice of a project handle this app dials, spelled structurally the
 * way the Docs app's bridge spells its own: a config worker's `this.env`
 * fits it, and this entry never has to import the SDK (whose types bring
 * Cloudflare's runtime types along, which a phone does not have).
 */
type VoiceAgentProject = {
  [Symbol.dispose](): void;
  workers: { get(ref: unknown): unknown };
};

export type VoiceAgentEnv = { ITX: { get(): Promise<VoiceAgentProject> } };

export interface VoiceAgentAppOptions {
  /**
   * The app slug the voice web client answers on — `voice` by default, so
   * `voice--<project>` (or `voice.<custom host>`). Requests for any other
   * slug, or for the project itself, are not this app's: `fetch` returns
   * null and the worker's own routing carries on.
   */
  appSlug?: string;
}

/**
 * The voice agent as a project worker sees it — the packaged-app shape every
 * starter app has: a partial `fetch` for its app slug, and typed methods on
 * the guest. No worker refs, no handle plumbing.
 *
 * ```ts
 * export default class extends IterateWorkerEntrypoint {
 *   #voice = VoiceAgentApp.create(this.env);
 *   async fetch(req: Request) {
 *     return (await this.#voice.fetch(req)) ?? new Response("my project");
 *   }
 * }
 * ```
 */
export const VoiceAgentApp = {
  create(env: VoiceAgentEnv, options: VoiceAgentAppOptions = {}) {
    const appSlug = options.appSlug ?? "voice";
    const dial = async <T>(run: (guest: VoiceAgentRpc) => Promise<T>): Promise<T> => {
      const project = await env.ITX.get();
      try {
        /* The platform hands back a generic dynamic-worker handle, since it
         * cannot know a guest's own methods. Those methods are this
         * package's contract — VoiceAgentRpc, which the entrypoint class
         * implements — so this is the one place a handle is typed as the
         * guest, instead of every caller doing it. */
        const guest = project.workers.get(voiceAgentEntrypointRef) as VoiceAgentRpc & {
          [Symbol.dispose](): void;
        };
        try {
          return await run(guest);
        } finally {
          guest[Symbol.dispose]();
        }
      } finally {
        project[Symbol.dispose]();
      }
    };
    return {
      /**
       * The voice app's requests, by app slug; null for everything else.
       * The browser client that will answer here is not built yet
       * (iterate/iterate tasks/2026-09-08-voice-web-chat-app.md), so today
       * the slug answers 501 and says so, rather than pretending.
       */
      fetch: async (request: Request): Promise<Response | null> => {
        if (request.headers.get("x-iterate-app") !== appSlug) return null;
        return new Response(
          "The voice web client is not built yet. This project's voice agent answers the boards, the voicelab CLI and the mobile app; a browser client is tracked in iterate/iterate tasks/2026-09-08-voice-web-chat-app.md.",
          { status: 501, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      },
      /** Put the agent on a conversation stream; a fresh `/agents/voice/*` path when none is named. */
      setup: (setup: SetupVoiceAgentOptions = {}): Promise<SetupVoiceAgentResult> =>
        dial((guest) => guest.setupVoiceAgent(setup)),
      /** Take the agent off a stream. */
      remove: (target: { streamPath: string }): Promise<{ streamPath: string }> =>
        dial((guest) => guest.removeVoiceAgent(target)),
      /** Have the live call on a stream say a line now — and hang up after it, if asked. */
      say: (line: SayOptions): Promise<SayResult> => dial((guest) => guest.say(line)),
    };
  },
};
