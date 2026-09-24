// A project host while the control plane is down (src/worker.ts, src/control-plane/last-known-project.ts).
// On 2026-09-24 the `CONTROL_PLANE` singleton was unreachable for 188 s, a deploy landed inside the
// outage, and every project host failed after 12–15 s: the new isolates had no project memo. Each
// row here creates its project (and claims its own hostname) straight on the control plane's Durable
// Object, so the worker under test (Vite's built worker, in this isolate) has never looked either
// up — a fresh isolate, as the deploy's were — then makes that Durable Object's reads throw what the
// outage threw, lose their connection, or never answer.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, type MockInstance, onTestFinished, test, vi } from "vitest";
import { appConfigOf, sessionSigningSecretOf } from "../src/app-config.ts";
import { signClaims, verifyClaims } from "../src/caller.ts";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { admitProjectHost } from "../src/control-plane/last-known-project.ts";
import { controlPlane, controlPlaneStub, ORIGIN, signedInSession, until } from "./support.ts";

/** How long a failing read may keep a visitor: a throw or a cut at once; a hang its bound, 3 s
 *  (edge.ts READ_TIMEOUT_MS). The platform took 12–15 s to fail. */
const WAIT_MS = { throws: 1_000, "is cut": 1_000, hangs: 4_500 } as const;

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
    expect(Date.now() - started).toBeLessThan(WAIT_MS[how]);
    // admitted: the project's own context answered (it has no site yet)
    expect(served).toMatchObject({ status: 404 });
    expect(await served.text()).toMatch(/has no site yet/);
    expect(controlPlaneWarns(warn)).toEqual([
      {
        event: "control-plane.platform-failure-stale-project",
        name: new URL(host).hostname,
        project: slug,
        method: "project",
        waitedMs: expect.any(Number),
        message: failed(how, "project"),
        copies: [{ what: `project/${slug}`, ageMs: expect.any(Number) }],
      },
    ]);

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
  expect(Date.now() - started).toBeLessThan(WAIT_MS.hangs);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(controlPlaneWarns(warn)).toEqual([
    {
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
    },
  ]);
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
    expect(Date.now() - started).toBeLessThan(WAIT_MS[how]);
    await expectUnavailable(refused, new URL(host).hostname);
    expect(controlPlaneWarns(warn)).toEqual([
      {
        event: "control-plane.platform-failure-unavailable",
        name: new URL(host).hostname,
        method: "project",
        waitedMs: expect.any(Number),
        message: failed(how, "project"),
      },
    ]);
  },
);

test("a copy the platform did not sign is no copy: one in an older shape, or signed with another secret, and the host answers 503", async () => {
  for (const forged of [
    (_key: string, value: unknown) => JSON.stringify({ value, rememberedAt: Date.now() }),
    (key: string, value: unknown) =>
      signClaims(
        { copy: "last-known-project", key, value, rememberedAt: Date.now() },
        "not-the-platform-secret",
      ),
  ]) {
    const { slug, projectId, host } = await catalogOnlyProject("forged");
    const key = keyOf(`project/${slug}`);
    const cache = await caches.open("last-known-projects");
    await cache.put(
      key,
      new Response(await forged(key, { id: projectId, slug, orgId: "org_forged" })),
    );
    const outage = await failReads("throws");
    const warn = vi.spyOn(console, "warn");

    await expectUnavailable(await call(host), new URL(host).hostname);
    expect(controlPlaneWarns(warn)).toEqual([
      expect.objectContaining({ event: "control-plane.platform-failure-unavailable" }),
    ]);
    warn.mockRestore();
    await outage.end();
  }
});

test("a hostname moved to another project: the control plane's next answer rewrites the copy, so an outage reaches the new project, never the old", async () => {
  const from = await catalogOnlyProject("moved-from", { ownHostname: true });
  const to = await catalogOnlyProject("moved-to");
  const { hostname } = new URL(from.host);
  await rememberedByAnEarlierIsolate(from.host); // this isolate's copy: `from`
  await controlPlaneStub().releaseHostname(from.projectId, hostname);
  await controlPlaneStub().claimHostname(to.projectId, hostname);
  // the same isolate, past its thirty-second hostname memo, asks again and hears `to`
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 31_000);
  await rememberedByAnEarlierIsolate(from.host);
  vi.useRealTimers();
  await failReads("throws");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  expect(await call(from.host)).toMatchObject({ status: 404 });
  expect(controlPlaneWarns(warn)).toEqual([
    expect.objectContaining({
      event: "control-plane.platform-failure-stale-project",
      project: to.projectId,
    }),
  ]);
});

test("a hostname its project removed: the control plane's null answer deletes the copy, so an outage answers 503", async () => {
  const { projectId, host } = await catalogOnlyProject("removed", { ownHostname: true });
  const { hostname } = new URL(host);
  await rememberedByAnEarlierIsolate(host);
  await controlPlaneStub().releaseHostname(projectId, hostname);
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 31_000);
  await rememberedByAnEarlierIsolate(host, { admitted: false });
  vi.useRealTimers();
  expect(
    await (await caches.open("last-known-projects")).match(keyOf(`hostname/${hostname}`)),
  ).toBe(undefined);
  await failReads("throws");

  await expectUnavailable(await call(host), hostname);
});

test("a host the worker admits leaves this data center a signed copy of each answer", async () => {
  const { projectId, host } = await catalogOnlyProject("written", { ownHostname: true });
  const { hostname } = new URL(host);

  expect(await call(host)).toMatchObject({ status: 404 });
  const [address, row] = await until("the worker's copies", async () => {
    const copies = await Promise.all([
      copyAt(`hostname/${hostname}`),
      copyAt(`project/${projectId}`),
    ]);
    return copies.every(Boolean) && copies;
  });
  expect(address).toMatchObject({
    copy: "last-known-project",
    key: keyOf(`hostname/${hostname}`),
    value: { project: projectId, routingSlug: null, basePath: "" },
  });
  expect(row).toMatchObject({
    copy: "last-known-project",
    key: keyOf(`project/${projectId}`),
    value: { id: projectId },
  });
});

test("while the control plane answers, a request never reads the last-known copies: the control plane admits it", async () => {
  const { projectId, host } = await catalogOnlyProject("copy-unread", { ownHostname: true });
  await rememberedByAnEarlierIsolate(host);
  const prototype = Object.getPrototypeOf(await caches.open("last-known-projects")) as Cache;
  const matches = vi.spyOn(prototype, "match");
  const puts = vi.spyOn(prototype, "put");
  onTestFinished(() => {
    matches.mockRestore();
    puts.mockRestore();
  });
  const reads = await spyOnReads();

  const served = await call(host);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(reads.projectByHostname).toHaveBeenCalledOnce();
  expect(reads.project).toHaveBeenCalledWith(projectId);
  // the one match a worker makes while the control plane answers is an isolate's single read-back
  // of a copy it has just written, never a read before its write
  for (const [index, [key]] of matches.mock.calls.entries()) {
    const written = puts.mock.calls.findIndex(([put]) => String(put) === String(key));
    expect(written).toBeGreaterThanOrEqual(0);
    expect(puts.mock.invocationCallOrder[written]).toBeLessThan(
      matches.mock.invocationCallOrder[index]!,
    );
  }
});

test("a signed-in visitor while admission found the control plane down: their access has no copy, so a 503 at once, logged once", async () => {
  const visitor = await signedInVisitor();
  const host = `https://${visitor.slug}-own.example.test/`;
  await controlPlaneStub().claimHostname(visitor.projectId, new URL(host).hostname);
  await rememberedByAnEarlierIsolate(host);
  const outage = await failReads("throws", ["projectByHostname", "project", "accessibleTo"]);
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  const started = Date.now();
  const refused = await call(host, { authorization: `Bearer ${visitor.token}` });
  expect(Date.now() - started).toBeLessThan(WAIT_MS.throws);
  await expectUnavailable(refused, new URL(host).hostname);
  expect(controlPlaneWarns(warn)).toEqual([
    {
      event: "control-plane.platform-failure-unavailable",
      name: new URL(host).hostname,
      method: "projectByHostname",
      waitedMs: expect.any(Number),
      message: failed("throws", "projectByHostname"),
    },
  ]);
  expect(outage.reads.accessibleTo).not.toHaveBeenCalled();
});

test("a signed-in visitor whose access read fails while admission read through: a 503, logged once", async () => {
  const visitor = await signedInVisitor();
  const host = `https://${visitor.slug}.projects.test/`;
  // past the five seconds the worker keeps a person's access (edge.ts), so it is read
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  await failReads("throws", ["accessibleTo"]);
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  const refused = await call(host, { authorization: `Bearer ${visitor.token}` });
  vi.useRealTimers();
  await expectUnavailable(refused, new URL(host).hostname);
  expect(controlPlaneWarns(warn)).toEqual([
    {
      event: "control-plane.platform-failure-unavailable",
      name: new URL(host).hostname,
      method: "accessibleTo",
      waitedMs: expect.any(Number),
      message: failed("throws", "accessibleTo"),
    },
  ]);
});

/** The warns a project host's admission logs (`control-plane.*`): the context Durable Objects this
 *  isolate also runs log their own, on their own timers. */
function controlPlaneWarns(warn: MockInstance<typeof console.warn>) {
  return warn.mock.calls
    .map(([entry]) => entry as { event?: unknown } | undefined)
    .filter((entry) => String(entry?.event).startsWith("control-plane."));
}

/** How a row makes the control plane's reads fail. */
type Failure = "throws" | "is cut" | "hangs";

/** What each failure reads as in the logs, for the read that failed first. */
function failed(how: Failure, method: string) {
  if (how === "hangs") return `The control plane did not answer ${method} within 3000 ms`;
  return `The control plane failed ${method}: ${how === "throws" ? "internal error; reference = workers-test" : "Network connection lost."}`;
}

/** The project host's 503 when the control plane is down and nothing stands in. */
async function expectUnavailable(response: Response, hostname: string) {
  expect(response).toMatchObject({ status: 503 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe(
    `503: the platform could not look up ${hostname} just now; try again in a minute\n`,
  );
}

/** A copy's cache key (last-known-project.ts): the platform's origin and what was read. */
const keyOf = (what: string) => `${ORIGIN}/.iterate/last-known/${what}`;

/** The claims a copy holds, verified with the platform's secret; undefined when there is none. */
async function copyAt(what: string) {
  const cached = await (await caches.open("last-known-projects")).match(keyOf(what));
  if (!cached) return undefined;
  return verifyClaims(await cached.text(), await sessionSigningSecretOf(appConfigOf(env)));
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

/** A person signed in, with a project of their own and a personal token for it. */
async function signedInVisitor() {
  const session = await signedInSession(`visitor-${crypto.randomUUID().slice(0, 8)}@example.com`);
  const slug = `visited-${crypto.randomUUID().slice(0, 8)}`;
  const { projectId } = await (
    await session.projects.create({ project: slug })
  ).invoke(["itx", ["whoami"]]);
  const { token } = await session.grants.mint({ name: "Visitor", projects: [projectId] });
  return { slug, projectId: projectId as string, token: token as string };
}

/** What an earlier isolate did on its first visit while the control plane answered: the source
 *  module's own admission (its memos are not the built worker's) keeps this data center's copies
 *  current. `admitted: false`: the host is no project host now. */
async function rememberedByAnEarlierIsolate(host: string, { admitted = true } = {}) {
  const writes: Promise<unknown>[] = [];
  const admission = await admitProjectHost(controlPlane(), {
    config: appConfigOf(env),
    url: new URL(host),
    platformOrigin: ORIGIN,
    ctx: { waitUntil: (write) => writes.push(write) },
  });
  expect(Boolean(admission?.project)).toBe(admitted);
  await Promise.all(writes);
}

/** The control plane Durable Object's reads a project host makes (`projectByHostname`, `project`,
 *  or those `methods`), failing until the row ends (or `end()`): throwing workerd's opaque internal
 *  error, as the outage did; cut at the transport (workerd's `retryable` stamp, retryable-error.ts);
 *  or never answering. The Durable Object runs in this isolate, so its class's methods are replaced
 *  where every call finds them. */
async function failReads(
  how: Failure,
  methods: readonly (keyof ControlPlaneDurableObject & string)[] = ["project", "projectByHostname"],
) {
  const answers: (() => void)[] = [];
  const failing = () => {
    if (how === "throws") throw new Error("internal error; reference = workers-test");
    if (how === "is cut")
      throw Object.assign(new Error("Network connection lost."), { retryable: true });
    // the reads are synchronous; over RPC a promise is awaited all the same — this one only once
    // the row ends
    return new Promise<null>((resolve) => answers.push(() => resolve(null)));
  };
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) => {
      const prototype = Object.getPrototypeOf(instance) as Record<string, () => unknown>;
      return Object.fromEntries(
        methods.map((method) => [method, vi.spyOn(prototype, method).mockImplementation(failing)]),
      );
    },
  );
  // a hung read's promise belongs to the Durable Object's I/O context: it is answered from there
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    await runInDurableObject(controlPlaneStub(), () => {
      for (const answer of answers.splice(0)) answer();
    });
    for (const read of Object.values(reads)) read.mockRestore();
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

function call(url: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(url, { redirect: "manual", headers }));
}
