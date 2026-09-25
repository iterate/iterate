// api.ts — `itx.voice`, the voice service's published type. Voice is userspace: a project installs
// it (install.ts mounts worker.ts as the `itx.voice` rewrite rule), the platform never ships it, so
// iterate/api does not name it. Importing this module registers the root on iterate/api's
// `InstalledAppRoots`, and a caller that knows voice is installed writes
// `itx as IterateContextApiWith<"voice">`. worker.ts `implements VoiceApi`; Kit's firmware calls
// `setupVoiceAgent` over the wire (apps/kit/firmware/components/voice/src/voice_loop.c).
import type { z } from "zod";
import type { ScreenImageInput, ScreenInfo } from "./screen.ts";

/** `itx.voice`: the device's press, the screen renderer, and the installer's liveness probe. */
export interface VoiceApi {
  /** The installer's check that the mounted service answers; `cacheKey` names the voice-agent build. */
  health(): Promise<{ ok: true; projectId: string; cacheKey: string }>;
  /** Render `image.html` in Browser Run at the device's advertised resolution and upload it to
   *  `itx.clients[device].screen` in its chunk size; `image: null` restores the call-status view. */
  setImage(input: z.input<typeof ScreenImageInput>): Promise<
    | { shown: false; bytes: number; renderMs: number; transferMs: number; totalMs: number }
    | {
        shown: true;
        width: number;
        height: number;
        format: z.infer<typeof ScreenInfo>["preferredFormat"];
        bytes: number;
        renderMs: number;
        transferMs: number;
        totalMs: number;
      }
  >;
  /** The press: create the agent at `streamPath` (default `/agents/voice/<uuid>`), swap its
   *  processor for the voice relay and delegate, and start the call under `activation`. `screen`
   *  adds the screen instructions for a device whose path names it. */
  setupVoiceAgent(options: {
    streamPath?: string;
    activation: string;
    screen?: boolean;
  }): Promise<{ streamPath: string }>;
}

declare module "iterate/api" {
  interface InstalledAppRoots {
    voice: VoiceApi;
  }
}
