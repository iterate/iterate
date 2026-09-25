// __workers-tests__/expression-fetch-deploy-reset.test.ts — a deploy resets every context, and an
// expression fetch that dialed another context meets the reset as "Durable Object reset because its
// code was updated.". prd os-prd, 2026-09-25 14:45:21Z (the deploy of #3155): the first requests to
// two tunnels' hosts found the config worker's loader cold, its producer's read of `/repos/config`
// met that context's reset, and each answered an uncoded 500 the prd fault alarm paged on. The
// expected outcome: the read the cacheKey names is read again (context/worker-loader.ts); a
// terminal fetch through `cd` is sent again when it cannot do anything twice, a GET or HEAD with no
// body (context/built-ins.ts `cd`); anything else is a 503 with `Retry-After: 1`, logged
// `expression-fetch.deploy-reset` at info and never reported (iterate-context-durable-object.ts).
// The reset is the test's: `state.abort` with the deploy's words, mid-call, on the context dialed.
import { runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ItxExpression } from "iterate/expression";
import { stub } from "./support.ts";

const DEPLOY_RESET = "Durable Object reset because its code was updated.";

test.for([
  {
    name: "a GET is sent again to the fresh context and answers",
    init: { method: "GET" },
    answer: { status: 200, text: "GET served", retryAfter: null },
    logs: [["warn", "cd.deploy-reset-fetch-retry"]],
  },
  {
    name: "a POST with a body is not sent again: a 503 to retry in a second, never reported",
    init: { method: "POST", body: "form=1" },
    answer: { status: 503, text: `expression fetch error: ${DEPLOY_RESET}\n`, retryAfter: "1" },
    logs: [["info", "expression-fetch.deploy-reset"]],
  },
])("$name", async ({ init, answer, logs }) => {
  const project = `prj_deploy_reset_fetch_${init.method.toLowerCase()}`;
  const events = logEvents();
  const served = fetchOf(project, [
    "itx",
    ["cd", "/site"],
    "workers",
    ["get", { source: { "worker.js": slowSite } }],
  ])(init);
  await resetMidCall(`${project}.iterate/site`);
  expect(await served).toEqual(answer);
  expect(events()).toEqual(logs);
});

test("a cold loader's producer read that meets the deploy is read again, and the page answers", async () => {
  const project = "prj_deploy_reset_producer";
  const events = logEvents();
  const served = fetchOf(project, [
    "itx",
    "workers",
    [
      "get",
      {
        source: [
          "itx",
          ["cd", "/repos/config"],
          "workers",
          ["get", { source: { "worker.js": slowProducer } }],
          ["modules"],
        ],
        cacheKey: "site@1",
      },
    ],
  ])({ method: "POST", body: "form=1" });
  await resetMidCall(`${project}.iterate/repos/config`);
  expect(await served).toEqual({ status: 200, text: "POST served", retryAfter: null });
  expect(events()).toEqual([["warn", "workers.deploy-reset-source-retry"]]);
});

/** A context's expression fetch of `expression`, answered as status, text and `Retry-After`. */
const fetchOf = (project: string, expression: ItxExpression) => async (init: RequestInit) => {
  const response = await stub(project).fetch(
    new Request("https://site.test/", {
      ...init,
      headers: { "x-itx-expression": JSON.stringify(expression) },
    }),
  );
  return {
    status: response.status,
    text: await response.text(),
    retryAfter: response.headers.get("retry-after"),
  };
};

/** What a deploy does to `name` while a call on it sleeps: its reset, in the deploy's words. */
async function resetMidCall(name: string) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await runInDurableObject(stub(name), (_instance, state) => {
    state.abort(DEPLOY_RESET);
    return Promise.resolve();
  }).catch(() => undefined); // abort() throws by design
}

/** The deploy-reset lines the platform logs from here on, as [level, event]; and never an issue. */
function logEvents() {
  const spies = (["info", "warn", "error"] as const).map(
    (level) => [level, vi.spyOn(console, level)] as const,
  );
  onTestFinished(() => spies.forEach(([, spy]) => spy.mockRestore()));
  return () => {
    const lines = spies.flatMap(([level, spy]) =>
      spy.mock.calls.map(([line]) => [level, String((line as { event?: unknown })?.event)]),
    );
    expect(lines.filter(([, event]) => event === "issue")).toEqual([]);
    return lines.filter(([, event]) => event.includes("deploy-reset"));
  };
}

/** A site that takes a second to answer: long enough for the reset to land mid-call. */
const slowSite = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  async fetch(request) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return new Response(request.method + " served");
  }
}`;

/** The config repo's stand-in: its modules take a second to read. */
const slowProducer = `
import { WorkerEntrypoint } from "cloudflare:workers";
export default class Producer extends WorkerEntrypoint {
  async modules() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      "worker.js": "import { WorkerEntrypoint } from 'cloudflare:workers'; export default class Site extends WorkerEntrypoint { fetch(request) { return new Response(request.method + ' served'); } }",
    };
  }
}`;
