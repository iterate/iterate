import { expect, test, vi } from "vitest";
import { CloudflareApiError } from "../lib/env-context.ts";
import { readWranglerBase } from "../../apps/os/scripts/generate-wrangler-config.ts";
import type { Cf } from "./preview-artifacts.ts";
import { deletePreviewDeployments } from "./preview-delete.ts";
import {
  groupPreviewDeployments,
  planSupersededCleanup,
  previewMemberSuffixes,
  type PreviewMember,
} from "./preview-sweep.ts";

const SUFFIXES = previewMemberSuffixes(
  readWranglerBase().kv_namespaces.map(({ binding }: { binding: string }) => binding),
);

const OBJECTS = ["prj_a_1/agents/support/red-dot.png", "prj_a_1/agents/support/square.png"];

test("two cleanups that supersede one deployment both succeed: each member the other took first counts as deleted", async () => {
  const account = fakeAccount();
  account.add("main-aaaaaaa", "2026-09-29T11:00:00Z");
  account.add("main-bbbbbbb", "2026-09-29T12:00:00Z");
  account.add("main-ccccccc", "2026-09-29T12:01:00Z");
  const deployments = account.listing();
  // each run keeps the other's, which that run still tests
  const plans = [
    planSupersededCleanup(deployments, "main-bbbbbbb", new Set(["main-ccccccc"])),
    planSupersededCleanup(deployments, "main-ccccccc", new Set(["main-bbbbbbb"])),
  ];
  expect(plans.map((plan) => plan.map(({ name }) => name))).toEqual([
    ["main-aaaaaaa"],
    ["main-aaaaaaa"],
  ]);

  const { outcomes, logs } = await capturingLogs(() =>
    Promise.all(plans.map((plan) => deletePreviewDeployments(account.cf, plan, async () => {}))),
  );

  expect(outcomes).toEqual([
    { failures: [], stuckNamespaces: [] },
    { failures: [], stuckNamespaces: [] },
  ]);
  expect(account.holds("main-aaaaaaa")).toEqual([]);
  expect(account.holds("main-bbbbbbb")).toHaveLength(13);
  expect(account.holds("main-ccccccc")).toHaveLength(13);
  // the race happened: the loser of each object's two deletes was answered NoSuchKey
  expect(account.answers.filter((answer) => /objects\/.*: 200\/10007$/.test(answer))).toHaveLength(
    OBJECTS.length,
  );
  expect(
    logs.filter((line) => line === "deleted deployment main-aaaaaaa (13 members)"),
  ).toHaveLength(2);
});

test("an R2 object delete answered 200/10007 NoSuchKey counts as deleted", async () => {
  const account = fakeAccount({
    // another run deleted each object between this run's listing and its delete
    fault: (method, path, state) => {
      if (method !== "DELETE" || !path.includes("/objects/")) return undefined;
      state.buckets.get("main-aaaaaaa-os-files")!.clear();
      return new CloudflareApiError(method, path, 200, [
        { code: 10007, message: "The specified key does not exist." },
      ]);
    },
  });
  account.add("main-aaaaaaa", "2026-09-29T11:00:00Z");

  const { outcomes, logs } = await capturingLogs(() =>
    deletePreviewDeployments(account.cf, account.listing(), async () => {}),
  );

  expect(outcomes).toEqual({ failures: [], stuckNamespaces: [] });
  expect(logs).toContain(
    "deleted R2 bucket main-aaaaaaa-os-files (0 objects deleted, 2 already gone)",
  );
  expect(account.holds("main-aaaaaaa")).toEqual([]);
});

test("a deployment deleted over a listing another run has since emptied: every member answers its kind's not-found, and each counts as deleted", async () => {
  const account = fakeAccount();
  account.add("main-aaaaaaa", "2026-09-29T11:00:00Z");
  const stale = account.listing();
  await capturingLogs(() => deletePreviewDeployments(account.cf, stale, async () => {}));
  account.answers.length = 0;

  const { outcomes, logs, warns } = await capturingLogs(() =>
    deletePreviewDeployments(account.cf, stale, async () => {}),
  );

  expect(outcomes).toEqual({ failures: [], stuckNamespaces: [] });
  expect(logs).toEqual([
    ...SUFFIXES.worker.map((app) => `worker main-aaaaaaa-${app} was already gone`),
    ...SUFFIXES.kv.map((suffix) => `KV namespace main-aaaaaaa-${suffix} was already gone`),
    "R2 bucket main-aaaaaaa-os-files was already gone",
    "D1 main-aaaaaaa-os-db was already gone",
    "deleted deployment main-aaaaaaa (13 members)",
  ]);
  expect(warns).toEqual(["Artifacts namespace main-aaaaaaa-os-repos did not exist; continuing."]);
  // each kind's not-found (preview-delete.ts `GONE`)
  const byKind = account.answers.map((answer) => {
    const [, kind, status] = /^\S+ \/([a-z0-9]+)\/.*: (\S+)$/.exec(answer)!;
    return `${kind} ${status}`;
  });
  expect(new Set(byKind)).toEqual(
    new Set([
      "workers 404/10007",
      "storage 404/10013",
      "r2 404/10006",
      "d1 404/7404",
      "artifacts 404/10200",
    ]),
  );
});

test.for([
  {
    refusal: "an R2 object's 403/10003",
    member: "os-files",
    path: /\/objects\//,
    status: 403,
    code: 10003,
  },
  {
    refusal: "an R2 object's 404 of another code",
    member: "os-files",
    path: /\/objects\//,
    status: 404,
    code: 7003,
  },
  {
    refusal: "an R2 bucket's 409/10008",
    member: "os-files",
    path: /\/r2\/buckets\/[^/]+$/,
    status: 409,
    code: 10008,
  },
  {
    refusal: "a worker's 409/10035",
    member: "os",
    path: /\/workers\/scripts\/main-aaaaaaa-os\?/,
    status: 409,
    code: 10035,
  },
  {
    refusal: "a KV namespace's 404 of another kind's code",
    member: "os-itx-kv",
    path: /\/storage\/kv\/namespaces\/kv-main-aaaaaaa-os-itx-kv$/,
    status: 404,
    code: 10007,
  },
  {
    refusal: "a D1's 500/7500",
    member: "os-db",
    path: /\/d1\/database\//,
    status: 500,
    code: 7500,
  },
])(
  "$refusal is a failure that names the member, and the other members still go",
  async ({ member, path: refused, status, code }) => {
    const account = fakeAccount({
      fault: (method, path) =>
        method === "DELETE" && refused.test(path)
          ? new CloudflareApiError(method, path, status, [{ code, message: "refused" }])
          : undefined,
    });
    account.add("main-aaaaaaa", "2026-09-29T11:00:00Z");

    const { outcomes } = await capturingLogs(() =>
      deletePreviewDeployments(account.cf, account.listing(), async () => {}),
    );

    expect(outcomes).toMatchObject({
      failures: [
        expect.stringMatching(
          new RegExp(
            `^main-aaaaaaa: 1 member\\(s\\) not deleted\\n  main-aaaaaaa-${member}: Cloudflare API DELETE \\S+ failed \\(${status}\\): \\[\\{"code":${code},`,
          ),
        ),
      ],
    });
    expect(account.holds("main-aaaaaaa")).toEqual([`main-aaaaaaa-${member}`]);
  },
);

/** The workers, KV, R2, D1 and Artifacts of each deployment `add` makes, in memory, a delete of
 *  what is already gone answered with its kind's not-found (preview-delete.ts `GONE`). A racing R2
 *  bucket delete gets the 404/10006 the API client's retry ends with (preview-delete.ts
 *  `deleteR2Bucket`). Each answer is a turn of the event loop later, so deletes run side by side
 *  interleave. `fault` answers a request with a failure instead, when it returns one. */
function fakeAccount(
  options: {
    fault?: (
      method: string,
      path: string,
      state: { buckets: Map<string, Set<string>> },
    ) => CloudflareApiError | undefined;
  } = {},
) {
  const workers = new Set<string>();
  const kv = new Map<string, string>();
  const buckets = new Map<string, Set<string>>();
  const d1 = new Map<string, string>();
  const artifacts = new Map<string, Set<string>>();
  const createdAt = new Map<string, string>();
  const answers: string[] = [];

  const add = (deployment: string, stamp: string) => {
    for (const app of SUFFIXES.worker) workers.add(`${deployment}-${app}`);
    for (const suffix of SUFFIXES.kv)
      kv.set(`kv-${deployment}-${suffix}`, `${deployment}-${suffix}`);
    buckets.set(`${deployment}-os-files`, new Set(OBJECTS));
    d1.set(`uuid-${deployment}`, `${deployment}-os-db`);
    artifacts.set(`${deployment}-os-repos`, new Set(["prj_a.repos--config", "prj_a.repos--main"]));
    createdAt.set(deployment, stamp);
  };

  const members = (): PreviewMember[] => {
    const stamp = (name: string) => createdAt.get(name.split("-").slice(0, 2).join("-"));
    return [
      ...[...workers].map((name): PreviewMember => ({
        kind: "worker",
        name,
        id: name,
        createdAt: stamp(name),
      })),
      ...[...kv].map(([id, title]): PreviewMember => ({ kind: "kv", name: title, id })),
      ...[...buckets.keys()].map((name): PreviewMember => ({
        kind: "r2",
        name,
        id: name,
        createdAt: stamp(name),
      })),
      ...[...d1].map(([uuid, name]): PreviewMember => ({
        kind: "d1",
        name,
        id: uuid,
        createdAt: stamp(name),
      })),
      ...[...artifacts.keys()].map((name): PreviewMember => ({
        kind: "artifacts",
        name,
        id: name,
        createdAt: stamp(name),
      })),
    ];
  };

  // a fake of the generic `cf<T>`: every answer is the JSON the real API returns for that route
  const cf = (async (path: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    await new Promise((resolve) => setImmediate(resolve));
    const answer = (status: number, code?: number) =>
      answers.push(`${method} ${path}: ${code ? `${status}/${code}` : status}`);
    const refuse = (status: number, code: number) => {
      answer(status, code);
      return new CloudflareApiError(method, path, status, [{ code, message: "not found" }]);
    };
    const fault = options.fault?.(method, path, { buckets });
    if (fault) {
      const [{ code }] = fault.details as [{ code: number }];
      answer(fault.status, code);
      throw fault;
    }
    const [kind, collection, id, sub, ...rest] = new URL(path, "https://api.test").pathname
      .split("/")
      .slice(1)
      .map(decodeURIComponent);
    const route = `${method} /${kind}/${collection}`;
    if (route === "DELETE /workers/scripts") {
      if (!workers.delete(id!)) throw refuse(404, 10007);
    } else if (route === "DELETE /storage/kv" && id === "namespaces") {
      if (!kv.delete(sub!)) throw refuse(404, 10013);
    } else if (route === "DELETE /d1/database") {
      if (!d1.delete(id!)) throw refuse(404, 7404);
    } else if (kind === "r2" && collection === "buckets") {
      const bucket = buckets.get(id!);
      if (!bucket) throw refuse(404, 10006);
      if (method === "GET" && sub === "objects") {
        answer(200);
        return [...bucket].map((key) => ({ key }));
      }
      if (method === "DELETE" && sub === "objects") {
        if (!bucket.delete(rest.join("/"))) throw refuse(200, 10007);
      } else if (method === "DELETE" && !sub) {
        if (bucket.size > 0) throw refuse(409, 10008);
        buckets.delete(id!);
      } else throw new Error(`unexpected ${method} ${path}`);
    } else if (kind === "artifacts" && collection === "namespaces") {
      const repos = artifacts.get(id!);
      // a missing namespace's repos list answers an empty page (preview-artifacts.ts)
      if (method === "GET" && sub === "repos") {
        answer(200);
        return [...(repos || [])].map((name) => ({ name }));
      }
      if (!repos) throw refuse(404, 10200);
      if (method === "GET") {
        answer(200);
        return { namespace: id, repo_count: repos.size, created_at: createdAt.get(id!) };
      }
      if (method === "DELETE" && sub === "repos") {
        if (!repos.delete(rest[0]!)) throw refuse(404, 10200);
      } else if (method === "DELETE" && !sub) {
        if (repos.size > 0) throw refuse(409, 10202);
        artifacts.delete(id!);
      } else throw new Error(`unexpected ${method} ${path}`);
    } else throw new Error(`unexpected ${method} ${path}`);
    answer(200);
    return null;
  }) as Cf;

  return {
    cf,
    add,
    answers,
    /** every deployment on the account, as preview.ts lists and groups them */
    listing: () => groupPreviewDeployments(members(), SUFFIXES),
    /** the names of what the account still holds of `deployment` */
    holds: (deployment: string) =>
      members()
        .map(({ name }) => name)
        .filter((name) => name.startsWith(`${deployment}-`)),
  };
}

/** `run`'s outcome, with the lines it logged and warned. */
async function capturingLogs<T>(run: () => Promise<T>) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const outcomes = await run();
    return {
      outcomes,
      logs: log.mock.calls.map(([line]) => line as string),
      warns: warn.mock.calls.map(([line]) => line as string),
    };
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
}
