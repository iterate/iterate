// __workers-tests__/edge-platform-failure.test.ts — the answer to a failure met in a bearer's
// personal-access-token index read, on a project host (src/worker.ts `platformFailureAnswer`) and on
// /api (src/api.ts), beside a project's own error on its host. Out of scope: the control plane's
// failures (project-host-control-plane-down.test.ts).
import { env, exports } from "cloudflare:workers";
import { codedError } from "iterate/lib";
import { expect, test, vi } from "vitest";
import { publishConfigWorker } from "../test-support/config-worker.ts";
import { ORIGIN, signedInSession } from "./support.ts";

const LOST = Object.assign(new Error("Network connection lost."), { retryable: true });
const OVERLOADED = codedError("UNAVAILABLE", "The account failed: overloaded", {
  kind: "overloaded",
  retryAfterMs: 10_000,
});
const DEFECT = new Error("our own defect");

test.for([
  {
    name: "a project host whose bearer's read lost its connection answers 503, Retry-After 1",
    where: "host",
    failure: LOST,
    answer: { status: 503, retryAfter: "1" },
    lines: [["warn", "worker.platform-failure-answered"]],
  },
  {
    name: "a project host whose bearer's read met a coded overload answers 503, Retry-After 10",
    where: "host",
    failure: OVERLOADED,
    answer: { status: 503, retryAfter: "10" },
    lines: [["warn", "worker.platform-failure-answered"]],
  },
  {
    name: "our own defect in a project host's bearer read is thrown: the runtime's 500",
    where: "host",
    failure: DEFECT,
    answer: { thrown: "our own defect" },
    lines: [],
  },
  {
    name: "/api whose bearer's read lost its connection answers 503, Retry-After 1, never an issue",
    where: "api",
    failure: LOST,
    answer: { status: 503, retryAfter: "1" },
    lines: [["warn", "oauth.platform-failure-token-validation"]],
  },
  {
    name: "our own defect in /api's bearer read is the library's bare 503, reported",
    where: "api",
    failure: DEFECT,
    answer: { status: 503, retryAfter: null },
    lines: [["error", "issue oauth.token-validation-failed"]],
  },
] as const)("$name", async ({ where, failure, answer, lines }) => {
  const visitor = await signedInVisitor(`edge-${where}`);
  const url = where === "host" ? `https://${visitor.slug}.projects.test/` : `${ORIGIN}/api`;
  failIndexReads(failure);
  const logged = logLines();
  expect(await answered(url, visitor.token)).toMatchObject(answer);
  expect(logged()).toEqual(lines);
});

test("a project's own error on its host stays its 500, reported, with no Retry-After", async () => {
  const visitor = await signedInVisitor("edge-own-error", SRC_THROWING_SITE);
  const logged = logLines();
  expect(await answered(`https://${visitor.slug}.projects.test/`, visitor.token)).toMatchObject({
    status: 500,
    retryAfter: null,
    text: "expression fetch error: the project's own defect\n",
  });
  expect(logged()).toEqual([["error", "issue iterate-context.expression-fetch"]]);
});

/** A site whose fetch throws: the project's own defect. */
const SRC_THROWING_SITE = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Site extends WorkerEntrypoint {
  fetch() { throw new Error("the project's own defect"); }
}`,
};

/** A person signed in, with a project of their own (serving `site`, when given) and a personal
 *  access token for it. */
async function signedInVisitor(prefix: string, site?: Record<string, string>) {
  const session = await signedInSession(`${prefix}-${crypto.randomUUID().slice(0, 8)}@example.com`);
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const itx = await session.projects.create({ project: slug });
  const { projectId } = await itx.invoke(["itx", ["whoami"]]);
  if (site) await publishConfigWorker(itx, ["itx", "workers", ["get", { source: site }]]);
  const { token } = await session.grants.mint({ name: "Visitor", projects: [projectId] });
  return { slug, token: token as string };
}

/** Every personal access token's index read (src/personal-access-token.ts) fails with `failure`
 *  until the row ends; the other reads of the same namespace answer. */
function failIndexReads(failure: Error) {
  const get = env.OAUTH_KV.get.bind(env.OAUTH_KV);
  vi.spyOn(env.OAUTH_KV, "get").mockImplementation(((key: string, ...rest: unknown[]) =>
    key.startsWith("personal-access-token:")
      ? Promise.reject(failure)
      : // KV's `get` is overloaded per type: the spy forwards whichever the worker called
        (get as (...args: unknown[]) => Promise<unknown>)(
          key,
          ...rest,
        )) as typeof env.OAUTH_KV.get);
}

/** `url` fetched with `token` as its bearer, as status, `Retry-After` and body; or what it threw. */
async function answered(url: string, token: string) {
  const response = await exports.default
    .fetch(new Request(url, { headers: { authorization: `Bearer ${token}` } }))
    .catch((error: unknown) => ({ thrown: (error as Error).message }));
  if ("thrown" in response) return response;
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    text: await response.text(),
  };
}

/** The platform-failure lines and issues logged from here on, as [level, event], an issue's event
 *  naming its failure site. */
function logLines() {
  const spies = (["warn", "error"] as const).map(
    (level) => [level, vi.spyOn(console, level)] as const,
  );
  return () =>
    spies.flatMap(([level, spy]) =>
      spy.mock.calls
        .map(([line]) => (line ?? {}) as { event?: string; failureSite?: string })
        .filter(({ event }) => event?.includes("platform-failure") || event === "issue")
        .map(({ event, failureSite }) => [
          level,
          event === "issue" ? `issue ${failureSite}` : event,
        ]),
    );
}
