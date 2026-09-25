// A project host while the control plane is down or slow (src/worker.ts, src/control-plane/edge.ts).
// Each row creates its project (and claims its own hostname) straight on the catalog, so the worker
// under test (Vite's built worker, in this isolate) has never looked either up — a fresh isolate, as
// a deploy's are — then makes the worker's catalog reads to D1 throw workerd's opaque internal
// error, lose their connection, or not answer until the row lets them. An /api session's reads
// give up at their own 3 s deadline instead (src/rpc.ts).
import { exports } from "cloudflare:workers";
import { expect, type MockInstance, onTestFinished, test, vi } from "vitest";
import { catalog, type CatalogRead, interceptCatalogReads, signedInSession } from "./support.ts";

test.for([
  ["throws", "internal error; reference = workers-test", false],
  ["is cut", "D1_ERROR: Network connection lost.", true],
] as const)(
  "the control plane's reads %s: a project host answers 503 at once, the failure logged once as the platform's",
  async ([how, message, retryable]) => {
    const { host } = await catalogOnlyProject(`down-${how.replace(" ", "-")}`);
    failReads(how);
    const warn = vi.spyOn(console, "warn");

    const started = Date.now();
    const refused = await call(host);
    expect(Date.now() - started).toBeLessThan(1_000);
    await expectUnavailable(refused, new URL(host).hostname);
    expect(controlPlaneWarns(warn)).toEqual([
      {
        event: "control-plane.platform-failure-d1",
        name: "project",
        waitedMs: expect.any(Number),
        retryable,
        message: `The control plane failed project: ${message}`,
      },
    ]);
  },
);

test("a slow read is waited for: the control plane's late answer serves the host, not a 503", async () => {
  const { host } = await catalogOnlyProject("slow", { ownHostname: true });
  const outage = failReads("hangs");
  const warn = vi.spyOn(console, "warn");

  let settled = false;
  const answer = call(host).finally(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(settled).toBe(false);
  outage.end();
  const served = await answer;
  // admitted: the project's own context answered (it has no site yet)
  expect(served).toMatchObject({ status: 404 });
  expect(await served.text()).toMatch(/has no site yet/);
  expect(controlPlaneWarns(warn)).toEqual([]);
  // the hostname's read brought the row: the admission's second read was a memo hit
  expect(outage.reads.projectByHostname).toHaveBeenCalledOnce();
  expect(outage.reads.project).not.toHaveBeenCalled();
});

test("a signed-in visitor while admission found the control plane down: a 503 before their access is read", async () => {
  const visitor = await signedInVisitor();
  const host = `https://${visitor.slug}-own.example.test/`;
  await catalog().claimHostname(visitor.projectId, new URL(host).hostname);
  const outage = failReads("throws", ["projectByHostname", "accessibleTo"]);

  const refused = await call(host, { authorization: `Bearer ${visitor.token}` });
  await expectUnavailable(refused, new URL(host).hostname);
  expect(outage.reads.accessibleTo).not.toHaveBeenCalled();
});

test("a signed-in visitor whose access read fails while admission read through: a 503, logged once", async () => {
  const visitor = await signedInVisitor();
  const host = `https://${visitor.slug}.projects.test/`;
  // past the five seconds the worker keeps a person's access (edge.ts), so it is read
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  failReads("throws", ["accessibleTo"]);
  const warn = vi.spyOn(console, "warn");

  const refused = await call(host, { authorization: `Bearer ${visitor.token}` });
  vi.useRealTimers();
  await expectUnavailable(refused, new URL(host).hostname);
  expect(controlPlaneWarns(warn)).toEqual([
    expect.objectContaining({ event: "control-plane.platform-failure-d1", name: "accessibleTo" }),
  ]);
});

test("/api while the control plane's reads hang: projects.get answers a retryable ControlPlaneUnavailableError at its 3 s deadline, logged once, and the late answer serves the next call", async () => {
  const session = await signedInSession(
    `api-deadline-${crypto.randomUUID().slice(0, 8)}@example.com`,
  );
  const slug = `api-deadline-${crypto.randomUUID().slice(0, 8)}`;
  const { projectId } = await (
    await session.projects.create({ project: slug })
  ).invoke(["itx", ["whoami"]]);
  // past the five seconds the worker keeps a person's access (edge.ts), so it is read
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => void vi.useRealTimers());
  vi.setSystemTime(Date.now() + 6_000);
  const outage = failReads("hangs", ["accessibleTo"]);
  const warn = vi.spyOn(console, "warn");

  const started = performance.now();
  const refusal = await session.projects.get(slug).then(
    () => null,
    (error: unknown) => error,
  );
  const waited = performance.now() - started;
  expect(refusal).toMatchObject({ retryable: true, method: "accessibleTo", waitedMs: 3_000 });
  expect(String(refusal)).toContain(
    "The control plane failed accessibleTo: no answer within 3000 ms",
  );
  expect(waited).toBeGreaterThanOrEqual(2_900);
  expect(waited).toBeLessThan(4_500);
  expect(controlPlaneWarns(warn)).toEqual([
    {
      event: "control-plane.platform-failure-read-deadline",
      method: "accessibleTo",
      waitedMs: 3_000,
    },
  ]);

  // the read ran on: its answer lands in the memo the next call reads
  outage.end();
  using project = await session.projects.get(slug);
  expect(await project.invoke(["itx", ["whoami"]])).toMatchObject({ projectId });
});

/** The warns the control plane logs (`control-plane.*`): the context Durable Objects this isolate
 *  also runs log their own, on their own timers. */
function controlPlaneWarns(warn: MockInstance<typeof console.warn>) {
  return warn.mock.calls
    .map(([entry]) => entry as { event?: unknown } | undefined)
    .filter((entry) => String(entry?.event).startsWith("control-plane."));
}

/** The project host's 503 when the control plane is down. */
async function expectUnavailable(response: Response, hostname: string) {
  expect(response).toMatchObject({ status: 503 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe(
    `503: the platform could not look up ${hostname} just now; try again in a minute\n`,
  );
}

/** A project the catalog holds and the worker under test never looked up; with no site, its apex
 *  answers its context's own 404 — the proof a request was admitted to it. `ownHostname`: the
 *  project also holds a hostname of its own (claimed as its processor claims one), and the row's
 *  host is that. */
async function catalogOnlyProject(prefix: string, options: { ownHostname?: boolean } = {}) {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const { id: projectId } = await catalog().createProject(
    { principal: { actor: "admin" } },
    { project: slug },
  );
  if (!options.ownHostname) return { slug, projectId, host: `https://${slug}.projects.test/` };
  await catalog().claimHostname(projectId, `${slug}.example.test`);
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

/** The worker's catalog reads a project host makes (`projectByHostname`, `project`, or those
 *  `reads`), failing until the row ends (or `end()`): throwing workerd's opaque internal error;
 *  losing D1's connection; or not answering until then, when each answers what it would have. A
 *  hung read is answered from its own request's timer: a promise another request resolves does
 *  not wake the request awaiting it. */
function failReads(
  how: "throws" | "is cut" | "hangs",
  reads: readonly CatalogRead[] = ["project", "projectByHostname"],
) {
  let ended = false;
  const spies = interceptCatalogReads({
    reads,
    with: <T>(answer: () => Promise<T>) => {
      if (ended) return answer();
      if (how === "throws")
        return Promise.reject(new Error("internal error; reference = workers-test"));
      if (how === "is cut") return Promise.reject(new Error("D1_ERROR: Network connection lost."));
      return new Promise<T>((resolve, reject) => {
        const wait = () => (ended ? answer().then(resolve, reject) : setTimeout(wait, 50));
        wait();
      });
    },
  });
  const end = () => {
    ended = true;
  };
  onTestFinished(end);
  return { end, reads: spies };
}

function call(url: string, headers: Record<string, string> = {}) {
  return exports.default.fetch(new Request(url, { redirect: "manual", headers }));
}
