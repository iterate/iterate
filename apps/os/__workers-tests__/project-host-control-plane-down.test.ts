// A project host while the control plane is down (src/worker.ts, src/control-plane/last-known-project.ts).
// On 2026-09-24 the `CONTROL_PLANE` singleton was unreachable for 188 s, a deploy landed inside the
// outage, and every project host failed after 12–15 s: the new isolates had no project memo. Each
// row here creates its project straight on the control plane's Durable Object, so the worker under
// test (Vite's built worker, in this isolate) has never looked it up — a fresh isolate, as the
// deploy's were — then makes that Durable Object's `project` read throw what the outage threw, lose
// its connection, or never answer.
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { projectForHost } from "../src/control-plane/last-known-project.ts";
import { controlPlane, controlPlaneStub } from "./support.ts";

/** A failing read's bound is 3 s (edge.ts READ_TIMEOUT_MS); the platform took 12–15 s to fail. */
const FAST_MS = 4_500;

test.for(["throws", "is cut", "hangs"] as const)(
  "the control plane's read %s: a host this data center served before serves from its last-known copy, logged as a platform failure; once the control plane answers again, it answers",
  async (how) => {
    const { slug, host } = await catalogOnlyProject(`stale-${how}`);
    await rememberedByAnEarlierIsolate(slug);
    const outage = await failProjectReads(how);
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());

    const started = Date.now();
    const served = await call(host);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
    // admitted: the project's own context answered (it has no site yet)
    expect(served).toMatchObject({ status: 404 });
    expect(await served.text()).toMatch(/has no site yet/);
    expect(warn).toHaveBeenCalledWith({
      event: "control-plane.platform-failure-stale-project",
      name: slug,
      method: "project",
      waitedMs: expect.any(Number),
      ageMs: expect.any(Number),
      message: {
        throws: expect.stringMatching(
          /^The control plane failed project after \d+ ms: internal error; reference = workers-test$/,
        ),
        "is cut": expect.stringMatching(
          /^The control plane failed project after \d+ ms: Network connection lost\.$/,
        ),
        hangs: "The control plane did not answer project within 3000 ms",
      }[how],
    });

    // the stale answer was never memoized: the next request asks the control plane
    await outage.end();
    const reads = await spyOnProjectReads();
    expect(await call(host)).toMatchObject({ status: 404 });
    expect(reads).toHaveBeenCalledWith(slug);
  },
);

test.for(["throws", "is cut", "hangs"] as const)(
  "the control plane's read %s: a host with no last-known copy answers 503 at once, logged as a platform failure",
  async (how) => {
    const { slug, host } = await catalogOnlyProject(`uncached-${how}`);
    await failProjectReads(how);
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());

    const started = Date.now();
    const refused = await call(host);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
    expect(refused).toMatchObject({ status: 503 });
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(await refused.text()).toBe(
      `503: the platform could not look up "${slug}" just now; try again in a minute\n`,
    );
    expect(warn).toHaveBeenCalledWith({
      event: "control-plane.platform-failure-unavailable",
      name: slug,
      method: "project",
      waitedMs: expect.any(Number),
      message: expect.stringMatching(/^The control plane (failed|did not answer) project/),
    });
  },
);

test("while the control plane answers, a request never reads the last-known copy: the control plane admits it", async () => {
  const { slug, host } = await catalogOnlyProject("copy-unread");
  await rememberedByAnEarlierIsolate(slug);
  const cache = await caches.open("last-known-projects");
  const matches = vi.spyOn(Object.getPrototypeOf(cache) as Cache, "match");
  onTestFinished(() => matches.mockRestore());
  const reads = await spyOnProjectReads();

  const served = await call(host);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(reads).toHaveBeenCalledWith(slug);
  expect(matches).not.toHaveBeenCalled();
});

/** A project the catalog holds and the worker under test never looked up; with no site, its apex
 *  answers its context's own 404 — the proof a request was admitted to it. */
async function catalogOnlyProject(prefix: string) {
  const slug = `${prefix.replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  await controlPlaneStub().createProject({ principal: { actor: "admin" } }, { project: slug });
  return { slug, host: `https://${slug}.projects.test/` };
}

/** What an earlier isolate did on its first visit while the control plane answered: the source
 *  module's own admission (its project memo is not the built worker's) writes this data center's
 *  copy. */
async function rememberedByAnEarlierIsolate(slug: string) {
  const writes: Promise<unknown>[] = [];
  const project = await projectForHost(controlPlane(), slug, {
    origin: `https://${slug}.projects.test`,
    ctx: { waitUntil: (write) => writes.push(write) },
  });
  expect(project).toMatchObject({ slug });
  await Promise.all(writes);
}

/** The control plane Durable Object's `project` read, failing until the row ends (or `end()`):
 *  throwing workerd's opaque internal error, as the outage did; cut at the transport (workerd's
 *  `retryable` stamp, retryable-error.ts); or never answering. The Durable Object runs in this
 *  isolate, so its class's method is replaced where every call finds it. */
async function failProjectReads(how: "throws" | "is cut" | "hangs") {
  let answer = () => {};
  const read = await runInDurableObject(controlPlaneStub(), (instance: ControlPlaneDurableObject) =>
    vi
      .spyOn(Object.getPrototypeOf(instance) as ControlPlaneDurableObject, "project")
      .mockImplementation(() => {
        if (how === "throws") throw new Error("internal error; reference = workers-test");
        if (how === "is cut")
          throw Object.assign(new Error("Network connection lost."), { retryable: true });
        // the read is synchronous; over RPC a promise is awaited all the same — this one only once
        // the row ends
        return new Promise<null>((resolve) => (answer = () => resolve(null))) as unknown as null;
      }),
  );
  // the hung read's promise belongs to the Durable Object's I/O context: it is answered from there
  const end = async () => {
    await runInDurableObject(controlPlaneStub(), () => answer());
    read.mockRestore();
  };
  onTestFinished(end);
  return { end };
}

/** The control plane Durable Object's `project` read, observed and unchanged. */
async function spyOnProjectReads() {
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) =>
      vi.spyOn(Object.getPrototypeOf(instance) as ControlPlaneDurableObject, "project"),
  );
  onTestFinished(() => reads.mockRestore());
  return reads;
}

function call(url: string) {
  return exports.default.fetch(new Request(url, { redirect: "manual" }));
}
