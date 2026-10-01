// vitest/os-workers/empty-runtime.ts — the runtime a Workers-suite file shares with the files before
// it (vitest.config.ts `isolate: false`), emptied of them: what fresh-file.ts runs first in every file,
// and fresh-file.test.ts pins. What it leaves behind, fresh-file.ts resets on its own: the modules and
// the deploy.
import { reset } from "cloudflare:test";
import { waitForGlobalWaitUntil } from "cloudflare:test-internal";
import { env } from "cloudflare:workers";

/**
 *  1. THE EARLIER FILE'S BACKGROUND WORK ENDS IN ITS OWN FILE. Every `waitUntil` a handler of the
 *     worker registered (the plugin keeps them all: a grant's recorded use, a platform fact) is
 *     awaited, up to the plugin's own 30 s bound, and its outcome dropped: nobody asked for it.
 *  2. EVERY OBJECT STOPS. `reset()` (workerd's `deleteAllDurableObjects`) aborts every Durable
 *     Object, the runner's own excepted (it prevents eviction), cancels every alarm and empties the
 *     SQLite of each LOADED one, facets included. D1, KV and the Cache API are Durable Objects in
 *     Miniflare too.
 *  3. EVERY FILE GOES. An object evicted after ten idle seconds, or by a test's
 *     `evictDurableObject`, is not loaded, and a reset leaves its storage for the next file to find
 *     under the same name (`prj_squatted` is two files' project; fresh-file.test.ts pins the reset's
 *     gap). So the pool deletes every stored file of this runtime (`TEST_STORAGE`,
 *     vitest.config.ts), and the next access to any object starts it empty.
 */
export async function emptyRuntime() {
  await waitForGlobalWaitUntil().catch(() => {});
  await reset();
  const emptied = await env.TEST_STORAGE.fetch("http://test-storage/", { method: "DELETE" });
  if (emptied.status !== 204)
    throw new Error(`the pool left this runtime's storage: ${emptied.status}`);
}
