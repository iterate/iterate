// __workers-tests__/fresh-file.ts — every Workers-suite file's first setup. The files share workerd
// runtimes (vitest.config.ts `isolate: false`): a runner that finished one file runs the next in the
// same Miniflare. So each file starts here as it would in a runtime of its own. On a runner's first
// file there is nothing to wait for or empty.
//  1. NOTHING OF THE EARLIER FILE: its background work ended, its objects stopped, its storage
//     deleted (empty-runtime.ts).
//  2. NO MODULE EVALUATED. `vi.resetModules()`: the worker's bundle and the suite's sources evaluate
//     again, so no memo (the control plane's project memo, the loader's generations, a grant's last
//     recorded use) outlives the file that filled it.
//  3. A NEW DEPLOY. Miniflare mints the version id (`CF_VERSION_METADATA.id`) per runtime. A new one
//     per file keeps the loader ids a file mints (src/context/worker-loader.ts: deploy × owner ×
//     source) off the isolates an earlier file warmed, whose `env.ITX` is a host step 1 stopped.
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { emptyRuntime } from "./empty-runtime.ts";

await emptyRuntime();
vi.resetModules();
env.CF_VERSION_METADATA.id = crypto.randomUUID();
