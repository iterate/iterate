import { voiceAgentEntrypointRef } from "./ref.ts";
import type {
  SetupVoiceAgentOptions,
  SetupVoiceAgentResult,
  VoiceAgentHealth,
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

/**
 * The voice agent as a project worker sees it: typed methods on the guest,
 * no worker refs, no handle plumbing.
 *
 * ```ts
 * export default class extends IterateWorkerEntrypoint {
 *   #voice = VoiceAgentApp.create(this.env);
 *   async fetch(req: Request) {
 *     return Response.json(await this.#voice.health());
 *   }
 * }
 * ```
 */
export const VoiceAgentApp = {
  create(env: VoiceAgentEnv) {
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
       * Prove the guest is built, running, and can reach this project. A
       * dynamic worker builds on the first call into it, so this is also
       * how to pay for that build on purpose (a deploy hook, a health route)
       * rather than inside somebody's first conversation.
       */
      health: (): Promise<VoiceAgentHealth> => dial((guest) => guest.health()),
      /** Put the agent on a conversation stream; a fresh `/agents/voice/*` path when none is named. */
      setup: (options: SetupVoiceAgentOptions = {}): Promise<SetupVoiceAgentResult> =>
        dial((guest) => guest.setupVoiceAgent(options)),
      /** Take the agent off a stream. */
      remove: (options: { streamPath: string }): Promise<{ streamPath: string }> =>
        dial((guest) => guest.removeVoiceAgent(options)),
    };
  },
};
