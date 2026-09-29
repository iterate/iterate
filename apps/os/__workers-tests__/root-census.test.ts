// THE ROOT CENSUS: no context sits on the hot path of another context's traffic. Every context
// appends and delivers at its own rate; the project root `/` may see a cached read now and then
// (the rule snapshot, at most one per context per SNAPSHOT_TTL_MS), never a call per event. The
// proof is the root's own count of inbound calls (`inboundCallCensus`, context/residency.ts), read
// before and after traffic that never names the root: it grows with the number of contexts and the
// time, never with the number of events or requests. A row is red while a delivery, a `cd` from
// loaded code or a project host's request is relayed through the root.
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { SNAPSHOT_TTL_MS } from "../src/context/rule-snapshots.ts";
import { publishConfigWorker } from "../e2e/support/config-worker.ts";
import {
  adminCredentials,
  appendAsPlatform,
  bornWithBirthRows,
  openSession,
  readLog,
  stub,
  until,
} from "./support.ts";

/** The project's config entrypoint (`itx.config`), which every context's birth row delivers to: it
 *  tells a `mark`'s own context it saw it, from loaded code. */
const SEEING_CONFIG = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    if (event.type !== "mark") return;
    await itx.cd(event.path).append({
      type: "seen",
      payload: { offset: event.offset },
      idempotencyKey: "seen:" + event.offset,
    });
  }
}
`,
};

/** A worker whose `files()` answers SEEING_CONFIG's files: a producer of the config's source. */
const FILES_OF_SEEING_CONFIG = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  files() {
    return ${JSON.stringify(SEEING_CONFIG)};
  }
}`,
};

/** A config worker that appends every event it is handed to `/sink`, from loaded code. */
const FORWARDING_WORKER = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class Forward extends WorkerEntrypoint {
  processEventBatch(events) {
    return withItx(this.env.ITX, async (itx) => {
      for (const event of events)
        await itx.cd("/sink").append({ type: "forwarded", payload: { offset: event.offset } });
    });
  }
}
`,
};

test("deliveries from many contexts, each born with the deployment's birth rows, to the project's config entrypoint cost the root a bounded number of calls, however many events flow", async () => {
  const project = `prj_census_${crypto.randomUUID().slice(0, 8)}`;
  const contexts = ["/a", "/b", "/c"].map((path) => `${project}.iterate${path}`);
  const EVENTS_PER_CONTEXT = 8;
  await bornWithBirthRows(project);
  await appendAsPlatform(project, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source: SEEING_CONFIG }]],
    },
  });
  for (const ctx of contexts) {
    await bornWithBirthRows(ctx);
    // One delivery first: the context is born, announced to the root, and its path to the
    // config entrypoint is warm before the census starts.
    await markAndAwaitDelivery(ctx);
  }

  const before = await census(project);
  const started = Date.now();
  for (let i = 0; i < EVENTS_PER_CONTEXT; i++)
    for (const ctx of contexts) await markAndAwaitDelivery(ctx);
  const after = await census(project);
  const elapsedMs = Date.now() - started;

  expect(after).toMatchObject({ incarnation: before.incarnation });
  // At most one snapshot read per context per TTL window; with a relay it is one call per event.
  const bound = contexts.length * Math.ceil(elapsedMs / SNAPSHOT_TTL_MS);
  expect(total(after.calls) - total(before.calls)).toBeLessThanOrEqual(bound);
});

test("a pointer whose worker is produced, as a publication's is, loads cold in each fresh context without relaying its producer through the root: the root counts no loaded call", async () => {
  const project = `prj_census_${crypto.randomUUID().slice(0, 8)}`;
  // the root has no row of its own here: the worker is first loaded, cold, by a fresh context
  // the producer reads the files through a root the loading isolate walks itself, as a
  // publication's `itx.repos.get('/repos/config').modules(…)` does
  const producer = ["itx", "workers", ["get", { source: FILES_OF_SEEING_CONFIG }], ["files"]];
  await appendAsPlatform(project, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source: producer, cacheKey: "c1" }]],
    },
  });
  const before = await census(project);
  for (const path of ["/a", "/b", "/c"]) {
    const ctx = `${project}.iterate${path}`;
    await bornWithBirthRows(ctx);
    await markAndAwaitDelivery(ctx);
  }
  const after = await census(project);
  expect(after).toMatchObject({ incarnation: before.incarnation });
  expect(after.calls.loaded - before.calls.loaded).toBe(0);
});

test("loaded code's cd goes straight to the context it names: a config worker forwarding every event to /sink costs the root no call", async () => {
  const project = `prj_census_${crypto.randomUUID().slice(0, 8)}`;
  const EVENTS = 8;
  await bornWithBirthRows(project);
  await stub(project).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "forward",
      target: ["itx", "workers", ["get", { source: FORWARDING_WORKER }], "processEventBatch"],
      consumes: ["mark"],
    },
  });
  // Born and warm before the census: /sink exists and has been announced to the root.
  await bornWithBirthRows(`${project}.iterate/sink`);
  await until("the root knows /sink", async () =>
    (await readLog(project)).some(
      (event) =>
        event.type === "events.iterate.com/itx/child-created" &&
        (event.payload as { childPath: string }).childPath === "/sink",
    ),
  );

  const before = await census(project);
  for (let i = 0; i < EVENTS; i++) await stub(project).append({ type: "mark" });
  await until("every mark reached /sink", async () => {
    const forwarded = (await readLog(`${project}.iterate/sink`)).filter(
      (event) => event.type === "forwarded",
    );
    return forwarded.length === EVENTS;
  });
  const after = await census(project);

  expect(after).toMatchObject({ incarnation: before.incarnation });
  expect(after.calls.loaded - before.calls.loaded).toBe(0);
  expect(after.calls.context - before.calls.context).toBe(0);
});

test("a project host's requests cost the root no call each: the edge serves the ingress from the root's snapshot, its config worker loaded where the request arrived", async () => {
  const slug = `census-host-${crypto.randomUUID().slice(0, 8)}`;
  const itx = (await openSession()).authenticate(adminCredentials());
  const root = await itx.projects.create({ project: slug });
  const { projectId } = await root.whoami();
  await publishConfigWorker(root, ["itx", "workers", ["get", { source: HOMEPAGE_WORKER }]]);
  const page = () => exports.default.fetch(`https://${slug}.projects.test/`);
  expect(await (await page()).text()).toBe("home"); // warm: the snapshot read, the isolate loaded

  const before = await census(projectId);
  const started = Date.now();
  for (let i = 0; i < 20; i++) expect(await (await page()).text()).toBe("home");
  const after = await census(projectId);

  expect(after).toMatchObject({ incarnation: before.incarnation });
  // at most one snapshot read per TTL window; through the root's Durable Object, one call a request
  const bound = Math.ceil((Date.now() - started) / SNAPSHOT_TTL_MS);
  expect(total(after.calls) - total(before.calls)).toBeLessThanOrEqual(bound);
});

test("the default template's homepage, which asks the root's itx who it is, costs the root no call a request: the stateless resolver answers whoami for the root itself", async () => {
  const slug = `census-whoami-${crypto.randomUUID().slice(0, 8)}`;
  const itx = (await openSession()).authenticate(adminCredentials());
  const root = await itx.projects.create({ project: slug });
  const { projectId } = await root.whoami();
  await publishConfigWorker(root, ["itx", "workers", ["get", { source: WHOAMI_HOMEPAGE }]]);
  const page = () => exports.default.fetch(`https://${slug}.projects.test/`);
  const homepage = `Homepage of project ${slug}\n`;
  expect(await (await page()).text()).toBe(homepage); // warm: the snapshot read, the isolate loaded

  const before = await census(projectId);
  const started = Date.now();
  for (let i = 0; i < 20; i++) expect(await (await page()).text()).toBe(homepage);
  const after = await census(projectId);

  expect(after).toMatchObject({ incarnation: before.incarnation });
  const bound = Math.ceil((Date.now() - started) / SNAPSHOT_TTL_MS);
  expect(total(after.calls) - total(before.calls)).toBeLessThanOrEqual(bound);
});

test("a project whose config is not published yet answers its hosts at the edge, costing the root no call a request, and the first request after its publication lands serves it", async () => {
  const slug = `census-unpublished-${crypto.randomUUID().slice(0, 8)}`;
  const itx = (await openSession()).authenticate(adminCredentials());
  const root = await itx.projects.create({ project: slug });
  const { projectId } = await root.whoami();
  await publishConfigWorker(root, ["itx", "config"]);
  const page = () => exports.default.fetch(`https://${slug}.projects.test/`);
  expect(await page()).toMatchObject({ status: 404 }); // warm: the snapshot read

  const before = await census(projectId);
  const started = Date.now();
  for (let i = 0; i < 10; i++) expect(await page()).toMatchObject({ status: 404 });
  const after = await census(projectId);
  const bound = Math.ceil((Date.now() - started) / SNAPSHOT_TTL_MS);
  expect(total(after.calls) - total(before.calls)).toBeLessThanOrEqual(bound);

  await appendAsPlatform(projectId, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source: HOMEPAGE_WORKER }]],
    },
  });
  expect(await (await page()).text()).toBe("home");
});

/** The default template's homepage (configs/default/worker.ts): the project's slug, from
 *  `itx.whoami()` at the root. */
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

/** A config worker whose page names nothing: the request is all that is counted. */
const HOMEPAGE_WORKER = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  fetch() { return new Response("home"); }
}
`,
};

/** Append one `mark` to `ctx` and wait until the config entrypoint its birth row delivers to has
 *  seen it. */
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

/** The root's census: its incarnation and inbound calls by kind. */
function census(project: string) {
  return stub(project).inboundCallCensus();
}

/** Every inbound call a census counted, of any kind. */
function total(calls: Awaited<ReturnType<typeof census>>["calls"]) {
  return calls.loaded + calls.context + calls.other;
}
