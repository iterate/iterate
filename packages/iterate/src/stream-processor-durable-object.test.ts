// StreamProcessorDurableObject in real workerd (Miniflare). The base class is a
// thin wrapper over createProcessorHost, so this proves the two things the
// pure-harness starter-app tests can't reach:
//   1. wake -> fold -> snapshot works end-to-end THROUGH createProcessorHost
//      (the starter tests inject fakes and never build the real host);
//   2. a subclass's `streamPath`/`recovery` field overrides take effect — the
//      guard against the base-field-initializer-before-subclass ordering trap
//      the lazy `#host` getter exists to prevent.
//
// Same Miniflare-over-esbuild lane as processor-facet.test.ts (no
// vitest-pool-workers, per docs/testing.md principle 6). The worker under test
// (stream-processor-durable-object.test-worker.ts) is bundled at suite start.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let mf: Miniflare;

beforeAll(async () => {
  // In-tree, not os.tmpdir(): workerd refuses module paths that `..` out of its
  // starting directory.
  const bundleDir = fileURLToPath(
    new URL("../node_modules/.cache/stream-processor-do-test", import.meta.url),
  );
  mkdirSync(bundleDir, { recursive: true });
  const outfile = join(bundleDir, "worker.mjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("./stream-processor-durable-object.test-worker.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    outfile,
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  mf = new Miniflare({
    modules: true,
    scriptPath: outfile,
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    // The host reads env.ITERATE_WORKER_VERSION; ITX is overridden inside the DO,
    // so no ITX binding is needed here.
    bindings: { ITERATE_WORKER_VERSION: "test-1" },
    durableObjects: { TESTDO: { className: "TestProcessorDO", useSQLite: true } },
  });
  await mf.ready;
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("StreamProcessorDurableObject in real workerd (Miniflare)", () => {
  test(
    "wakes through createProcessorHost, folds a delivered batch, and honors subclass config overrides",
    { timeout: 60_000 },
    async () => {
      const res = await mf.dispatchFetch("http://do/run", { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        preCount: number;
        checkpoint: number;
        postCount: number;
      };

      // preCount === 0 is the ordering-trap proof: the pre-wake snapshot only
      // returns (instead of throwing "learns its stream from the first wake")
      // because the subclass's `streamPath` override reached the host.
      expect(body.preCount).toBe(0);
      // Fresh processor: checkpoint starts at head.
      expect(body.checkpoint).toBe(0);
      // The delivered batch folded: 0 + 2 = 2, read back through the wake door's
      // snapshot verb.
      expect(body.postCount).toBe(2);
    },
  );
});
