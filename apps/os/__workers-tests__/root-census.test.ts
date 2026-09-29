// The root census (`inboundCallCensus`): other contexts' deliveries and a project host's requests
// cost the root at most a snapshot read per TTL, never a call each. Snapshots: rule-snapshots.test.ts.
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { SNAPSHOT_TTL_MS } from "../src/context/rule-snapshots.ts";
import { publishConfigWorker } from "../e2e/support/config-worker.ts";
import {
  adminCredentials,
  at,
  bornWithBirthRows,
  census,
  freshProject,
  openSession,
  pointAt,
  readLog,
  stub,
  totalCalls,
  until,
} from "./support.ts";

test("many contexts' deliveries to a produced config load it cold in each and cost the root a bounded census", async () => {
  const project = freshProject("prj_census");
  const contexts = ["/a", "/b", "/c"].map((path) => at(project, path));
  // the producer reads the files as a publication's `modules()` does, through no call to the root
  const producer = ["itx", "workers", ["get", { source: FILES_OF_SEEING_CONFIG }], ["files"]];
  await pointAt(project, producer, { cacheKey: "c1" });
  const cold = await census(project);
  for (const ctx of contexts) {
    await bornWithBirthRows(ctx);
    await markAndAwaitDelivery(ctx); // born, announced, the worker loaded
  }
  const before = await census(project);
  expect(before.calls.loaded - cold.calls.loaded).toBe(0);
  const started = Date.now();
  for (let i = 0; i < 8; i++) for (const ctx of contexts) await markAndAwaitDelivery(ctx);
  const after = await census(project);
  expect(after).toMatchObject({ incarnation: cold.incarnation });
  // at most one snapshot read per context per TTL window; a relay is one call per event
  const bound = contexts.length * Math.ceil((Date.now() - started) / SNAPSHOT_TTL_MS);
  expect(totalCalls(after) - totalCalls(before)).toBeLessThanOrEqual(bound);
});

test("a project host is served from the root's snapshot at no root call a request, unpublished or published", async () => {
  const slug = `census-host-${crypto.randomUUID().slice(0, 8)}`;
  const root = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: slug });
  const { projectId } = await root.whoami();
  await publishConfigWorker(root, ["itx", "config"]);
  const page = () => exports.default.fetch(`https://${slug}.projects.test/`);
  /** What `requests` requests, each checked by `answer`, cost the root, and the bound for them. */
  const costOf = async (requests: number, answer: (response: Response) => Promise<void>) => {
    const before = await census(projectId);
    const started = Date.now();
    for (let i = 0; i < requests; i++) await answer(await page());
    const after = await census(projectId);
    expect(after).toMatchObject({ incarnation: before.incarnation });
    return {
      calls: totalCalls(after) - totalCalls(before),
      bound: Math.ceil((Date.now() - started) / SNAPSHOT_TTL_MS),
    };
  };
  expect(await page()).toMatchObject({ status: 404 }); // warm: the snapshot read
  const unpublished = await costOf(10, async (response) =>
    expect(response).toMatchObject({ status: 404 }),
  );
  expect(unpublished.calls).toBeLessThanOrEqual(unpublished.bound);
  // the first request after the publication lands serves it; whoami is answered statelessly
  await pointAt(projectId, WHOAMI_HOMEPAGE);
  const homepage = `Homepage of project ${slug}\n`;
  expect(await (await page()).text()).toBe(homepage);
  const published = await costOf(20, async (response) =>
    expect(await response.text()).toBe(homepage),
  );
  expect(published.calls).toBeLessThanOrEqual(published.bound);
});

/** A config entrypoint that tells a `mark`'s own context it saw it, from loaded code. */
const SEEING_CONFIG = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    if (event.type !== "mark") return;
    await itx.cd(event.path).append({ type: "seen", payload: { offset: event.offset }, idempotencyKey: "seen:" + event.offset });
  }
}
`,
};

/** A producer of SEEING_CONFIG's source, as a publication's `modules()` is one. */
const FILES_OF_SEEING_CONFIG = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { files() { return ${JSON.stringify(SEEING_CONFIG)}; } }`,
};

/** The default template's homepage (configs/default/worker.ts): the slug from the root's whoami. */
const WHOAMI_HOMEPAGE = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async fetch() {
    const { projectSlug } = await this.withItx((itx) => itx.whoami());
    return new Response("Homepage of project " + projectSlug + "\\n");
  }
}
`,
};

/** Append one `mark` to `ctx` and wait until the config entrypoint has seen it. */
async function markAndAwaitDelivery(ctx: string) {
  // (cast: workers-types' Rpc.Serializable types a StreamEvent-returning stub method as `never`)
  const [mark] = (await stub(ctx).append({ type: "mark" })) as unknown as { offset: number }[];
  await until(`${ctx} saw offset ${mark!.offset}`, async () =>
    (await readLog(ctx)).some(
      (event) =>
        event.type === "seen" && (event.payload as { offset: number }).offset === mark!.offset,
    ),
  );
}
