import { expect, test, vi } from "vitest";
import { CloudflareApiError } from "../../../scripts/lib/env-context.ts";
import {
  deleteArtifactsNamespace,
  renderStuckArtifactsNamespacesPage,
  type Cf,
} from "./preview-artifacts.ts";

const NAMESPACE = "os-preview-pr1-repos";
const ROUTE = `/artifacts/namespaces/${NAMESPACE}`;

test("a repo delete answering 500/10400 once is retried on the next round, logged, and the namespace goes", async () => {
  let failed = false;
  const api = fakeArtifactsApi(
    ["prj_a.repos--config", "prj_a.site", "prj_b.repos--config"],
    (method, path) => {
      if (method !== "DELETE" || !path.endsWith("prj_a.repos--config") || failed) return undefined;
      failed = true;
      return internalError(method, path);
    },
  );

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({
    error: undefined,
    platformFailureRetries: [
      {
        event: "preview.platform-failure-retry",
        name: NAMESPACE,
        round: 1,
        platformFailureRounds: 1,
        status: 500,
        codes: [10400],
      },
    ],
    // the retry's, then the two confirming reads' (confirmedGone)
    waits: [2000, 2000, 2000],
  });
  expect(api.state()).toEqual({ repos: [], namespaceExists: false });
  // the other two deletes ran in the failing round; the next round deleted the one that failed
  expect(api.requests.filter((request) => /^DELETE .*\/repos\//.test(request))).toHaveLength(4);
});

test("a 5xx on the repos list or on the namespace delete is a platform failure too", async () => {
  const failedOnce = new Set<string>();
  const api = fakeArtifactsApi(["prj_a.repos--config"], (method, path) => {
    const request = `${method} ${path.startsWith(`${ROUTE}/repos?`) ? "list" : path}`;
    if (request !== "GET list" && request !== `DELETE ${ROUTE}`) return undefined;
    if (failedOnce.has(request)) return undefined;
    failedOnce.add(request);
    return new CloudflareApiError(method, path, 503, []);
  });

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({ error: undefined, waits: [2000, 4000, 2000, 2000] });
  expect(outcome.platformFailureRetries).toHaveLength(2);
  expect(api.state()).toEqual({ repos: [], namespaceExists: false });
});

test("a platform failure that persists surfaces after 8 rounds — bounded, each one logged", async () => {
  const api = fakeArtifactsApi(["prj_a.repos--config"], (method, path) =>
    method === "DELETE" ? internalError(method, path) : undefined,
  );

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({
    error: {
      message: expect.stringMatching(/DELETE .*prj_a\.repos--config failed \(500\).*10400/),
    },
    waits: [2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000, 15_000],
  });
  expect(outcome.platformFailureRetries).toHaveLength(8);
});

test("a refusal that is not a 5xx surfaces at once, never retried", async () => {
  const api = fakeArtifactsApi(["prj_a.repos--config"], (method, path) =>
    method === "DELETE" ? new CloudflareApiError(method, path, 403, [{ code: 10000 }]) : undefined,
  );

  expect(await deleting(api.cf)).toMatchObject({
    error: { message: expect.stringMatching(/failed \(403\)/) },
    platformFailureRetries: [],
    waits: [],
  });
});

test("a namespace that does not exist is the expected case: nothing deleted, no retry", async () => {
  const api = fakeArtifactsApi([], (method, path) =>
    path === ROUTE && method === "GET"
      ? new CloudflareApiError(method, path, 404, [{ code: 10200 }])
      : undefined,
  );

  expect(await deleting(api.cf)).toMatchObject({
    error: undefined,
    warns: [`Artifacts namespace ${NAMESPACE} did not exist; continuing.`],
  });
  expect(api).toMatchObject({ requests: [`GET ${ROUTE}`] });
});

// ── a namespace Cloudflare will not delete (pr2817's, measured 2026-09-24) ─────────────────────

test("an empty namespace Cloudflare keeps refusing is reported stuck after ~2 minutes, not thrown", async () => {
  // repo_count 1, an empty repos list, and DELETE 409/10202, for a day and counting
  const api = fakeArtifactsApi(["prj_a.repos--config"], (method, path) => {
    if (path === ROUTE && method === "DELETE") return notEmpty(method, path);
    return undefined;
  });

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({
    error: undefined,
    stuck: { namespace: NAMESPACE, repoCount: 1, createdAt: "2026-09-22T13:11:36Z" },
  });
  expect(outcome.stuckEvents).toMatchObject([
    {
      event: "preview.platform-failure-stuck-namespace",
      namespace: NAMESPACE,
      repoCount: 1,
      listedRepos: 0,
      refusedRounds: 60,
    },
  ]);
  // bounded: 60 refusals 2 s apart, one round of repo deletes first
  expect(outcome.waits.reduce((sum, ms) => sum + ms, 0)).toBe(118_000);
  expect(api.requests.filter((request) => request === `DELETE ${ROUTE}`)).toHaveLength(60);
});

test("a 10305 or a 404 while another delete is in flight is not taken for deleted", async () => {
  // with other delete loops running: 10305 answers and 404 reads, and the namespace stayed
  let deletes = 0;
  let reads = 0;
  const api = fakeArtifactsApi([], (method, path) => {
    if (path !== ROUTE) return undefined;
    if (method === "DELETE") {
      const answer = [
        new CloudflareApiError(method, path, 409, [{ code: 10305 }, { code: 20100 }]),
        new CloudflareApiError(method, path, 404, [{ code: 10200 }]),
      ][deletes++];
      return answer || notEmpty(method, path);
    }
    // the existence check sees it; after the accepted-looking 404, two confirming reads answer a
    // phantom 404 and the third sees it again
    return [1, 2].includes(reads++)
      ? new CloudflareApiError(method, path, 404, [{ code: 10200 }])
      : undefined;
  });

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({
    error: undefined,
    stuck: { namespace: NAMESPACE, repoCount: 1 },
  });
  expect(api.requests.filter((request) => request === `GET ${ROUTE}`)).toHaveLength(5);
  expect(outcome.logs).not.toContainEqual(expect.stringContaining("deleted Artifacts namespace"));
});

test("an accepted namespace delete is confirmed by three reads before it counts as deleted", async () => {
  const api = fakeArtifactsApi(["prj_a.repos--config"], () => undefined);

  const outcome = await deleting(api.cf);

  expect(outcome).toMatchObject({
    error: undefined,
    stuck: undefined,
    logs: [`deleted Artifacts namespace ${NAMESPACE} (1 repos)`],
  });
  expect(api.requests.filter((request) => request === `GET ${ROUTE}`)).toHaveLength(4);
});

test("the sweep's page names each stuck namespace, what to escalate, and the run", () => {
  const page = renderStuckArtifactsNamespacesPage(
    [{ namespace: NAMESPACE, repoCount: 1, createdAt: "2026-09-22T13:11:36Z" }],
    "https://depot.dev/orgs/x/workflows/y",
  );

  expect(page.split("\n")).toEqual([
    "🚨 preview sweep: Cloudflare will not delete 1 Artifacts namespace(s) <@U067G4QRFK2>",
    `• ${NAMESPACE}: repo_count 1 but no repos listed; the namespace DELETE answers 409/10202 "Namespace is not empty" (created 2026-09-22)`,
    "A Cloudflare Artifacts fault, not a commit's: escalate it to Cloudflare with these names. The sweep tries again each night.",
    "<https://depot.dev/orgs/x/workflows/y|sweep run>",
  ]);
});

/** Cloudflare's answer to deleting a namespace that still holds a repo, or says it does. */
function notEmpty(method: string, path: string) {
  return new CloudflareApiError(method, path, 409, [
    { code: 10202, message: "Namespace is not empty" },
  ]);
}

/** What the Artifacts API answered on 2026-09-23 20:34 and 20:35 to two PR-close repo deletes. */
function internalError(method: string, path: string) {
  return new CloudflareApiError(method, path, 500, [
    { code: 10400, message: "An internal error occurred." },
  ]);
}

/** The Artifacts API over one namespace, in memory: a repo delete lands at once. `fault` answers
 *  a request with a failure instead, when it returns one. */
function fakeArtifactsApi(
  repoNames: string[],
  fault: (method: string, path: string) => CloudflareApiError | undefined,
) {
  const repos = new Set(repoNames);
  let namespaceExists = true;
  const requests: string[] = [];
  // a fake of the generic `cf<T>`: every answer is the JSON the real API returns for that route
  const cf = (async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${path}`);
    const failure = fault(method, path);
    if (failure) throw failure;
    const notFound = new CloudflareApiError(method, path, 404, [{ code: 10200 }]);
    if (!namespaceExists) throw notFound;
    if (path === ROUTE && method === "GET")
      // pr2817's count, which stayed 1 whatever the repos list said
      return { namespace: NAMESPACE, repo_count: 1, created_at: "2026-09-22T13:11:36Z" };
    if (path.startsWith(`${ROUTE}/repos?`)) return [...repos].map((name) => ({ name }));
    if (path.startsWith(`${ROUTE}/repos/`) && method === "DELETE") {
      if (!repos.delete(decodeURIComponent(path.slice(`${ROUTE}/repos/`.length)))) throw notFound;
      return null;
    }
    if (path === ROUTE && method === "DELETE") {
      if (repos.size > 0) throw new CloudflareApiError(method, path, 409, [{ code: 10202 }]);
      namespaceExists = false;
      return null;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }) as Cf;
  return { cf, requests, state: () => ({ repos: [...repos], namespaceExists }) };
}

/** Delete the namespace with every wait recorded instead of slept; its warns, split. */
async function deleting(cf: Cf) {
  const waits: number[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { stuck, error } = await deleteArtifactsNamespace(cf, NAMESPACE, async (ms) => {
      waits.push(ms);
    }).then(
      (stuck) => ({ stuck, error: undefined }),
      (failure: Error) => ({ stuck: undefined, error: failure }),
    );
    const warns = warn.mock.calls.map(([entry]) => entry);
    return {
      error,
      stuck,
      waits,
      warns,
      logs: log.mock.calls.map(([entry]) => entry),
      stuckEvents: warns.filter(
        (entry) => entry?.event === "preview.platform-failure-stuck-namespace",
      ),
      platformFailureRetries: warns.filter(
        (entry) => entry?.event === "preview.platform-failure-retry",
      ),
    };
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
}
