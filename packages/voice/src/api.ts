// api.ts — `itx.voice`, the voice service's published type. Voice is userspace: a project installs
// it (install.ts names worker.ts, as `voice.ts` of its config re-exports it, in the `itx.voice`
// rewrite rule), the platform never ships it, so
// iterate/api does not name it. Importing this package registers the root on iterate/api's
// `InstalledAppRoots`, and a caller that knows voice is installed writes
// `itx as IterateContextApiWith<"voice">`. worker.ts `implements VoiceApi`; Kit's firmware calls
// `setupVoiceAgent` over the wire (iterate/kit's firmware/components/voice/src/voice_loop.c).
import type { z } from "zod";
import type { ScreenImageInput, ScreenInfo } from "./screen.ts";

/** `itx.voice`: the device's press, the screen renderer, and the installer's liveness probe. */
export interface VoiceApi {
  /** The installer's check that the service loads and answers, in the project it names. */
  health(): Promise<{ ok: true; projectId: string }>;
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
  /** The press: create the agent at `streamPath`, which answers the call's delegations, put the
   *  voice relay beside it and start the call under `activation`. A caller names its call
   *  `/agents/voice/<client>/<UTC>-<activation>` (a Kit board's `<client>` is its `itx.clients`
   *  name, the voice app's is `web`). `screen` is the `itx.clients` name of a device with a
   *  screen: the call gets instructions for drawing on it with `setImage`. */
  setupVoiceAgent(options: {
    streamPath: string;
    activation: string;
    screen?: string;
  }): Promise<{ streamPath: string }>;
}

declare module "iterate/api" {
  interface InstalledAppRoots {
    voice: VoiceApi;
  }
}
