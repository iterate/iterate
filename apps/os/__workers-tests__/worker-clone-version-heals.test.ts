// __workers-tests__/worker-clone-version-heals.test.ts — a LOADED worker (`itx.workers.get(spec)`, the
// project ingress's config worker) whose cached isolate answers V8's clone-version text to every
// call retires its loaded identity: a GET or HEAD is replayed once on a fresh isolate and answers; a
// request with a body fails as before, and the next request answers from the fresh isolate. prd,
// garple.com, 2026-09-24 20:47Z: every page 500 with this text until a redeploy (built-ins.ts
// `workers.get`; the facet twin is facet-clone-version-heals.test.ts). The condition is prd's, so
// the worker here plays it: the first isolate to serve a request marks itself in kv and throws the
// text on every request it serves, for good.
import { expect, test, vi } from "vitest";
import { stub } from "./support.ts";

const CLONE_VERSION = "Unable to deserialize cloned data due to invalid or unsupported version.";

test.for([
  {
    name: "a GET is replayed once on a fresh isolate and answers",
    first: { method: "GET" },
    firstAnswer: { status: 200, text: "GET from a healthy isolate" },
    event: "workers.platform-failure-retry",
  },
  {
    name: "a POST with a body is not replayed: it fails, and the next request answers from a fresh isolate",
    first: { method: "POST", body: "form=1" },
    firstAnswer: { status: 500, text: `expression fetch error: ${CLONE_VERSION}\n` },
    event: "workers.platform-failure-retire",
  },
])("$name", async ({ first, firstAnswer, event }) => {
  const s = stub(`prj_worker_clone_${first.method.toLowerCase()}`);
  const warns = vi.spyOn(console, "warn");
  const page = async (init: RequestInit) => {
    const response = await s.fetch(
      new Request("https://site.test/", {
        ...init,
        headers: { "x-itx-expression": JSON.stringify(["itx", "workers", ["get", { source }]]) },
      }),
    );
    return { status: response.status, text: await response.text() };
  };

  expect(await page(first)).toEqual(firstAnswer);
  expect(await page({ method: "GET" })).toEqual({
    status: 200,
    text: "GET from a healthy isolate",
  });
  expect(
    warns.mock.calls.filter(([line]) => String(line?.event).startsWith("workers.platform-failure")),
  ).toEqual([
    [
      expect.objectContaining({
        event,
        requestMethod: first.method,
        message: expect.stringContaining("Unable to deserialize cloned data"),
      }),
    ],
  ]);
});

/** The worker: the first isolate that serves a request is the bad cache entry — it marks itself in
 *  kv and throws the clone-version text on every request it serves; any other isolate answers. */
const source = {
  "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/sdk";
let isolate;
export default class Site extends WorkerEntrypoint {
  fetch(request) {
    isolate ??= crypto.randomUUID();
    return withItx(this.env.ITX, async (itx) => {
      let bad = await itx.kv.get("bad-isolate");
      if (!bad) {
        await itx.kv.put("bad-isolate", isolate);
        bad = isolate;
      }
      if (bad === isolate) throw new Error(${JSON.stringify(CLONE_VERSION)});
      return new Response(request.method + " from a healthy isolate");
    });
  }
}`,
};
