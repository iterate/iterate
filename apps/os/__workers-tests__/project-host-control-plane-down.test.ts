// A project host while the control plane is down (src/worker.ts, src/control-plane/last-known-project.ts).
// On 2026-09-24 the `CONTROL_PLANE` singleton was unreachable for 188 s, a deploy landed inside the
// outage, and every project host failed after 12–15 s: the new isolates had no project memo. Each
// row here creates its project (and claims its own hostname) straight on the control plane's Durable
// Object, so the worker under test (Vite's built worker, in this isolate) has never looked either
// up — a fresh isolate, as the deploy's were — then makes that Durable Object's reads throw what the
// outage threw, lose their connection, or never answer.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, onTestFinished, test, vi } from "vitest";
import { appConfigOf } from "../src/app-config.ts";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { admitProjectHost } from "../src/control-plane/last-known-project.ts";
import { controlPlane, controlPlaneStub, ORIGIN } from "./support.ts";

/** A failing read's bound is 3 s (edge.ts READ_TIMEOUT_MS); the platform took 12–15 s to fail. */
const FAST_MS = 4_500;

test.for(["throws", "is cut", "hangs"] as const)(
  "the control plane's reads %s: a host this data center served before serves from its last-known copy, logged once as a platform failure; once the control plane answers again, it answers",
  async (how) => {
    const { slug, host } = await catalogOnlyProject(`stale-${how}`);
    await rememberedByAnEarlierIsolate(host);
    const outage = await failReads(how);
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());

    const started = Date.now();
    const served = await call(host);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
    // admitted: the project's own context answered (it has no site yet)
    expect(served).toMatchObject({ status: 404 });
    expect(await served.text()).toMatch(/has no site yet/);
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "control-plane.platform-failure-stale-project",
      name: new URL(host).hostname,
      project: slug,
      method: "project",
      waitedMs: expect.any(Number),
      message: failed(how, "project"),
      copies: [{ what: `project/${slug}`, ageMs: expect.any(Number) }],
    });

    // the stale answer was never memoized: the next request asks the control plane
    await outage.end();
    const reads = await spyOnReads();
    expect(await call(host)).toMatchObject({ status: 404 });
    expect(reads.project).toHaveBeenCalledWith(slug);
  },
);

test("a project's own hostname: its address and its row both stand in, after ONE bounded wait", async () => {
  const { projectId, host } = await catalogOnlyProject("stale-own", { ownHostname: true });
  await rememberedByAnEarlierIsolate(host);
  const outage = await failReads("hangs");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  const started = Date.now();
  const served = await call(host);
  // one bounded wait (the hostname's read), not two: the row's copy is tried first
  expect(Date.now() - started).toBeLessThan(FAST_MS);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(warn).toHaveBeenCalledExactlyOnceWith({
    event: "control-plane.platform-failure-stale-project",
    name: new URL(host).hostname,
    project: projectId,
    method: "projectByHostname",
    waitedMs: expect.any(Number),
    message: failed("hangs", "projectByHostname"),
    copies: [
      { what: `hostname/${new URL(host).hostname}`, ageMs: expect.any(Number) },
      { what: `project/${projectId}`, ageMs: expect.any(Number) },
    ],
  });
  expect(outage.reads.project).not.toHaveBeenCalled();
});

test.for(["throws", "is cut", "hangs"] as const)(
  "the control plane's reads %s: a host with no last-known copy answers 503 at once, logged as a platform failure",
  async (how) => {
    const { host } = await catalogOnlyProject(`uncached-${how}`);
    await failReads(how);
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());

    const started = Date.now();
    const refused = await call(host);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
    expect(refused).toMatchObject({ status: 503 });
    expect(refused.headers.get("cache-control")).toBe("no-store");
    const { hostname } = new URL(host);
    expect(await refused.text()).toBe(
      `503: the platform could not look up ${hostname} just now; try again in a minute\n`,
    );
    expect(warn).toHaveBeenCalledExactlyOnceWith({
      event: "control-plane.platform-failure-unavailable",
      name: hostname,
      method: "project",
      waitedMs: expect.any(Number),
      message: failed(how, "project"),
    });
  },
);

test("while the control plane answers, a request never reads the last-known copies: the control plane admits it", async () => {
  const { projectId, host } = await catalogOnlyProject("copy-unread", { ownHostname: true });
  await rememberedByAnEarlierIsolate(host);
  const cache = await caches.open("last-known-projects");
  const matches = vi.spyOn(Object.getPrototypeOf(cache) as Cache, "match");
  onTestFinished(() => matches.mockRestore());
  const reads = await spyOnReads();

  const served = await call(host);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(reads.projectByHostname).toHaveBeenCalledOnce();
  expect(reads.project).toHaveBeenCalledWith(projectId);
  expect(matches).not.toHaveBeenCalled();
});

/** How a row makes the control plane's reads fail. */
type Failure = "throws" | "is cut" | "hangs";

/** What each failure reads as in the logs, for the read that failed first. */
function failed(how: Failure, method: string) {
  if (how === "hangs") return `The control plane did not answer ${method} within 3000 ms`;
  const cause =
    how === "throws" ? "internal error; reference = workers-test" : "Network connection lost.";
  return expect.stringMatching(
    new RegExp(
      `^The control plane failed ${method} after \\d+ ms: ${cause.replaceAll(".", "\\.")}$`,
    ),
  );
}

/** A project the catalog holds and the worker under test never looked up; with no site, its apex
 *  answers its context's own 404 — the proof a request was admitted to it. `ownHostname`: the
 *  project also holds a hostname of its own (claimed on the catalog, as project/custom-hostnames.ts
 *  does once Cloudflare answers), and the row's host is that. */
async function catalogOnlyProject(prefix: string, options: { ownHostname?: boolean } = {}) {
  const slug = `${prefix.replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const project = await controlPlaneStub().createProject(
    { principal: { actor: "admin" } },
    { project: slug },
  );
  if (!options.ownHostname)
    return { slug, projectId: project.id, host: `https://${slug}.projects.test/` };
  await controlPlaneStub().claimHostname(project.id, `${slug}.example.test`);
  return { slug, projectId: project.id, host: `https://${slug}.example.test/` };
}

/** What an earlier isolate did on its first visit while the control plane answered: the source
 *  module's own admission (its memos are not the built worker's) writes this data center's
 *  copies. */
async function rememberedByAnEarlierIsolate(host: string) {
  const writes: Promise<unknown>[] = [];
  const admitted = await admitProjectHost(controlPlane(), {
    config: appConfigOf(env),
    url: new URL(host),
    platformOrigin: ORIGIN,
    ctx: { waitUntil: (write) => writes.push(write) },
  });
  expect(admitted?.project).toBeTruthy();
  await Promise.all(writes);
}

/** The control plane Durable Object's reads a project host makes (`projectByHostname`, `project`),
 *  failing until the row ends (or `end()`): throwing workerd's opaque internal error, as the outage
 *  did; cut at the transport (workerd's `retryable` stamp, retryable-error.ts); or never answering.
 *  The Durable Object runs in this isolate, so its class's methods are replaced where every call
 *  finds them. */
async function failReads(how: Failure) {
  const answers: (() => void)[] = [];
  const failing = () => {
    if (how === "throws") throw new Error("internal error; reference = workers-test");
    if (how === "is cut")
      throw Object.assign(new Error("Network connection lost."), { retryable: true });
    // the reads are synchronous; over RPC a promise is awaited all the same — this one only once
    // the row ends
    return new Promise<null>((resolve) => answers.push(() => resolve(null))) as unknown as null;
  };
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) => {
      const prototype = Object.getPrototypeOf(instance) as ControlPlaneDurableObject;
      return {
        project: vi.spyOn(prototype, "project").mockImplementation(failing),
        projectByHostname: vi.spyOn(prototype, "projectByHostname").mockImplementation(failing),
      };
    },
  );
  // a hung read's promise belongs to the Durable Object's I/O context: it is answered from there
  const end = async () => {
    await runInDurableObject(controlPlaneStub(), () => {
      for (const answer of answers.splice(0)) answer();
    });
    reads.project.mockRestore();
    reads.projectByHostname.mockRestore();
  };
  onTestFinished(end);
  return { end, reads };
}

/** The control plane Durable Object's reads a project host makes, observed and unchanged. */
async function spyOnReads() {
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) => {
      const prototype = Object.getPrototypeOf(instance) as ControlPlaneDurableObject;
      return {
        project: vi.spyOn(prototype, "project"),
        projectByHostname: vi.spyOn(prototype, "projectByHostname"),
      };
    },
  );
  onTestFinished(() => {
    reads.project.mockRestore();
    reads.projectByHostname.mockRestore();
  });
  return reads;
}

function call(url: string) {
  return exports.default.fetch(new Request(url, { redirect: "manual" }));
}
