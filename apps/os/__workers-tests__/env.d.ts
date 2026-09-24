// The workers lane's `env` and `exports` (both from "cloudflare:workers") typed as the worker under
// test: its bindings (src/env.ts) and its main module (src/worker.ts — wrangler.base.jsonc `main`;
// the lane runs Vite's build of it). The augmentation pattern is workers-types' own
// (`Cloudflare.Env` / `Cloudflare.GlobalProps`, node_modules/@cloudflare/workers-types/index.d.ts).
import type { Env as WorkerEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import("../src/worker.ts");
    }
  }
}
