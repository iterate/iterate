// A project host while the control plane is down or slow (src/worker.ts,
// src/control-plane/last-known-project.ts). On 2026-09-24 the `CONTROL_PLANE` singleton was
// unreachable for 188 s, a deploy landed inside the outage, and every project host failed after
// 12–15 s: the new isolates had no project memo. Each row here creates its project (and claims its
// own hostname) straight on the control plane's Durable Object, so the worker under test (Vite's
// built worker, in this isolate) has never looked either up — a fresh isolate, as the deploy's were
// — then makes that Durable Object's reads throw what the outage threw, lose their connection, or
// not answer until the row lets them.
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, type MockInstance, onTestFinished, test, vi } from "vitest";
import type { ControlPlaneDurableObject } from "../src/control-plane/durable-object.ts";
import { lastKnownKey } from "../src/control-plane/last-known-project.ts";
import { controlPlaneStub, signedInSession, until } from "./support.ts";

/** How long a failing read may keep a visitor who has a copy: a throw or a cut at once; a hang the
 *  3 s admission waits before a copy stands in. The platform took 12–15 s to fail. */
const WAIT_MS = { throws: 1_000, "is cut": 1_000, hangs: 4_500 } as const;

test.for(["throws", "is cut", "hangs"] as const)(
  "the control plane's reads %s: a host serves from the copy the control plane wrote, logged once as a platform failure; once the control plane answers again, it answers",
  async (how) => {
    const { slug, host } = await catalogOnlyProject(`stale-${how}`);
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
        copies: [lastKnownKey("project", slug)],
      },
    ]);

    // the stale answer was never memoized: the next request asks the control plane
    await outage.end();
    const reads = await spyOnReads();
    expect(await call(host)).toMatchObject({ status: 404 });
    expect(reads.project).toHaveBeenCalledWith(slug);
  },
);

test("a project's own hostname: its copy stands in for its address and its row, after ONE 3 s wait", async () => {
  const { projectId, host } = await catalogOnlyProject("stale-own", { ownHostname: true });
  const outage = await failReads("hangs");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  const started = Date.now();
  const served = await call(host);
  // one wait (the hostname's read), not two: the hostname's copy holds the row
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
      copies: [lastKnownKey("hostname", new URL(host).hostname)],
    },
  ]);
  expect(outage.reads.project).not.toHaveBeenCalled();
});

test.for(["throws", "is cut"] as const)(
  "the control plane's reads %s: a host with no copy answers 503 at once, logged as a platform failure",
  async (how) => {
    const { host } = await catalogOnlyProject(`uncopied-${how}`, { copies: false });
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

test("a slow read with no copy is waited for: the control plane's late answer serves the host, not a 503", async () => {
  const { host } = await catalogOnlyProject("uncopied-slow", { copies: false });
  const outage = await failReads("hangs");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  let settled = false;
  const answer = call(host).finally(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS.hangs));
  expect(settled).toBe(false);
  await outage.end();
  const served = await answer;
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(controlPlaneWarns(warn)).toEqual([]);
});

test("the control plane writes a project's copies when it creates it, and a hostname's when it claims it", async () => {
  const { slug, projectId, host } = await catalogOnlyProject("written", { ownHostname: true });
  const row = { id: projectId, slug, orgId: expect.any(String) };

  expect(await copyAt(lastKnownKey("project", slug))).toEqual(row);
  expect(await copyAt(lastKnownKey("project", projectId))).toEqual(row);
  expect(await copyAt(lastKnownKey("hostname", new URL(host).hostname))).toEqual(row);
});

test("a hostname moved to another project: the release deletes its copy and the claim writes the new one, so an outage reaches the new project, never the old", async () => {
  const from = await catalogOnlyProject("moved-from", { ownHostname: true });
  const to = await catalogOnlyProject("moved-to");
  const { hostname } = new URL(from.host);
  await controlPlaneStub().releaseHostname(from.projectId, hostname);
  expect(await env.OAUTH_KV.get(lastKnownKey("hostname", hostname))).toBe(null);
  await controlPlaneStub().claimHostname(to.projectId, hostname);
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

test("a hostname its project removed: its copy goes before its claim, so an outage answers 503", async () => {
  const { projectId, host } = await catalogOnlyProject("removed", { ownHostname: true });
  const { hostname } = new URL(host);
  await controlPlaneStub().releaseHostname(projectId, hostname);
  expect(await env.OAUTH_KV.get(lastKnownKey("hostname", hostname))).toBe(null);
  await failReads("throws");

  await expectUnavailable(await call(host), hostname);
});

test("an unreadable copy of the host's own name is no copy, even when a name above it has one: the host answers 503, never the other project", async () => {
  const above = await catalogOnlyProject("above", { ownHostname: true });
  const below = await catalogOnlyProject("below");
  // claimed first: a claim is refused under another project's name, not above one
  const hostname = `docs.${new URL(above.host).hostname}`;
  await controlPlaneStub().releaseHostname(above.projectId, new URL(above.host).hostname);
  await controlPlaneStub().claimHostname(below.projectId, hostname);
  await controlPlaneStub().claimHostname(above.projectId, new URL(above.host).hostname);
  await failReads("throws");
  const get = env.OAUTH_KV.get.bind(env.OAUTH_KV) as (key: string, type: "json") => unknown;
  const gets = vi
    .spyOn(env.OAUTH_KV, "get")
    .mockImplementation(((key: string) =>
      key === lastKnownKey("hostname", hostname)
        ? Promise.reject(new Error("KV unavailable"))
        : get(key, "json")) as never);
  onTestFinished(() => gets.mockRestore());

  await expectUnavailable(await call(`https://${hostname}/`), hostname);
  expect(gets).toHaveBeenCalledWith(lastKnownKey("hostname", hostname), "json");
});

test("a release the KV delete fails keeps the claim, so the copy never outlives it: the hostname's processor asks again", async () => {
  const { projectId, host } = await catalogOnlyProject("release-fails", { ownHostname: true });
  const { hostname } = new URL(host);
  await runInDurableObject(controlPlaneStub(), async (instance: ControlPlaneDurableObject) => {
    const deletes = vi
      .spyOn((instance as unknown as { env: typeof env }).env.OAUTH_KV, "delete")
      .mockRejectedValueOnce(new Error("KV unavailable"));
    await expect(instance.releaseHostname(projectId, hostname)).rejects.toThrow(/KV unavailable/);
    deletes.mockRestore();
  });
  expect(await controlPlaneStub().projectByHostname([hostname])).toMatchObject({
    project: { id: projectId },
  });
  expect(await copyAt(lastKnownKey("hostname", hostname))).toMatchObject({ id: projectId });
});

test("the rows the catalog held before copies were written are backfilled once, by the control plane's alarm", async () => {
  const { slug, projectId, host } = await catalogOnlyProject("backfilled", { ownHostname: true });
  const keys = [
    lastKnownKey("project", slug),
    lastKnownKey("project", projectId),
    lastKnownKey("hostname", new URL(host).hostname),
  ];
  // the rows as they stood before this change: no copies, and no backfill yet
  await Promise.all(keys.map((key) => env.OAUTH_KV.delete(key)));
  // what the constructor does on the first start after this change: the alarm, due at once
  await runInDurableObject(controlPlaneStub(), async (_, state) => {
    state.storage.kv.delete("last-known-backfill");
    await state.storage.setAlarm(Date.now());
  });

  for (const key of keys) expect(await copyAt(key)).toMatchObject({ id: projectId });
  expect(
    await runInDurableObject(controlPlaneStub(), (_, state) =>
      state.storage.kv.get("last-known-backfill"),
    ),
  ).toBe("done");
});

test("while the control plane answers, a request never reads the copies, and a project's own hostname is ONE read", async () => {
  const { host } = await catalogOnlyProject("copy-unread", { ownHostname: true });
  const gets = vi.spyOn(env.OAUTH_KV, "get");
  onTestFinished(() => gets.mockRestore());
  const reads = await spyOnReads();

  const served = await call(host);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(reads.projectByHostname).toHaveBeenCalledOnce();
  // the hostname's read brought the row: the admission's second read is a memo hit
  expect(reads.project).not.toHaveBeenCalled();
  expect(gets.mock.calls.filter(([key]) => String(key).startsWith("last-known:"))).toEqual([]);
});

test("a signed-in visitor while admission found the control plane down: their access has no copy, so a 503 at once, logged once", async () => {
  const visitor = await signedInVisitor();
  const host = `https://${visitor.slug}-own.example.test/`;
  await controlPlaneStub().claimHostname(visitor.projectId, new URL(host).hostname);
  await copiesLanded(visitor);
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

test("a signed-in visitor while admission's read was only slow: their access is read, and they are served as a member", async () => {
  const visitor = await signedInVisitor();
  // a hostname of its own: the worker under test has never read it
  const host = `https://${visitor.slug}-own.example.test/`;
  await controlPlaneStub().claimHostname(visitor.projectId, new URL(host).hostname);
  await copiesLanded(visitor);
  await failReads("hangs");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());

  const started = Date.now();
  const served = await call(host, { authorization: `Bearer ${visitor.token}` });
  expect(Date.now() - started).toBeLessThan(WAIT_MS.hangs);
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(controlPlaneWarns(warn)).toEqual([
    expect.objectContaining({
      event: "control-plane.platform-failure-stale-project",
      message: failed("hangs", "projectByHostname"),
    }),
  ]);
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

/** The copy at `key` in `OAUTH_KV`, once it is there. */
const copyAt = (key: string) =>
  until(`the copy ${key}`, async () => (await env.OAUTH_KV.get(key, "json")) ?? undefined);

/** A project's copies, once the control plane's creation has written them. */
async function copiesLanded(project: { slug: string; projectId: string }) {
  await copyAt(lastKnownKey("project", project.slug));
  await copyAt(lastKnownKey("project", project.projectId));
}

/** A project the catalog holds and the worker under test never looked up; with no site, its apex
 *  answers its context's own 404 — the proof a request was admitted to it. `ownHostname`: the
 *  project also holds a hostname of its own (claimed on the catalog, as project/custom-hostnames.ts
 *  does once Cloudflare answers), and the row's host is that. `copies: false`: its copies are
 *  deleted once written, as for a row the control plane never wrote down. */
async function catalogOnlyProject(
  prefix: string,
  options: { ownHostname?: boolean; copies?: boolean } = {},
) {
  const slug = `${prefix.replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const { id: projectId } = await controlPlaneStub().createProject(
    { principal: { actor: "admin" } },
    { project: slug },
  );
  await copiesLanded({ slug, projectId });
  if (options.copies === false)
    await Promise.all(
      [slug, projectId].map((label) => env.OAUTH_KV.delete(lastKnownKey("project", label))),
    );
  if (!options.ownHostname) return { slug, projectId, host: `https://${slug}.projects.test/` };
  await controlPlaneStub().claimHostname(projectId, `${slug}.example.test`);
  return { slug, projectId, host: `https://${slug}.example.test/` };
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

/** The control plane Durable Object's reads a project host makes (`projectByHostname`, `project`,
 *  or those `methods`), failing until the row ends (or `end()`): throwing workerd's opaque internal
 *  error, as the outage did; cut at the transport (workerd's `retryable` stamp, retryable-error.ts);
 *  or not answering until then, when each answers what it would have. The Durable Object runs in
 *  this isolate, so its class's methods are replaced where every call finds them. */
async function failReads(
  how: Failure,
  methods: readonly (keyof ControlPlaneDurableObject & string)[] = ["project", "projectByHostname"],
) {
  const answers: (() => void)[] = [];
  const reads = await runInDurableObject(
    controlPlaneStub(),
    (instance: ControlPlaneDurableObject) => {
      const prototype = Object.getPrototypeOf(instance) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return Object.fromEntries(
        methods.map((method) => {
          const read = prototype[method]!;
          const failing = function (this: unknown, ...args: unknown[]) {
            if (how === "throws") throw new Error("internal error; reference = workers-test");
            if (how === "is cut")
              throw Object.assign(new Error("Network connection lost."), { retryable: true });
            // the reads are synchronous; over RPC a promise is awaited all the same — this one only
            // once the row lets it answer
            return new Promise((resolve) => answers.push(() => resolve(read.apply(this, args))));
          };
          return [method, vi.spyOn(prototype, method).mockImplementation(failing)];
        }),
      );
    },
  );
  // a hung read's promise belongs to the Durable Object's I/O context: it is answered from there
  let ended = false;
  const end = async () => {
    if (ended) return;
    ended = true;
    for (const read of Object.values(reads)) read.mockRestore();
    await runInDurableObject(controlPlaneStub(), () => {
      for (const answer of answers.splice(0)) answer();
    });
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
