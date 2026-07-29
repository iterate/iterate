// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { afterEach, expect, test, vi } from "vitest";
import ProjectWorker from "../../../config-repo-template/worker.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

afterEach(() => vi.unstubAllGlobals());

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

function deliver(
  worker: ProjectWorker,
  event: {
    type: string;
    path: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  return worker.processEventBatch({ events: [event] } as never);
}

test("template ships packaged apps behind a thin router", () => {
  // Vendor SDK surfaces are NOT seeded (built-ins live at
  // itx.integrations.<slug>), projects grow their own apps/ and
  // integrations/ by editing their repo. Shared apps such as the GitHub
  // linter come from the iterate package instead of copied source.
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");
  expect(paths.filter((path) => path.startsWith("apps/review-bot/"))).toEqual([]);

  const appPaths = paths.filter((path) => path.startsWith("apps/"));
  expect(appPaths).toEqual([
    "apps/guestbook/client.tsx",
    "apps/guestbook/server.tsx",
    "apps/guestbook/tsconfig.json",
  ]);
  expect(paths.filter((path) => path.startsWith("apps/todo/"))).toEqual([]);

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // React and zod remain temporarily because old persisted createApp refs may
  // compile the two Guestbook source-upgrade bridges once before the packaged
  // app removes their WAKE subscription.
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: expect.any(String),
    react: expect.any(String),
    zod: expect.any(String),
  });
});

test("project lifecycle cases directly install and handle the default heartbeat", async () => {
  const set = vi.fn(async (input: { key: string; recurrence: unknown; script: string }) => input);
  const project = {
    repos: { list: async () => [] },
    scheduler: { set },
    [Symbol.dispose]: vi.fn(),
  };
  const get = vi.fn(async () => project);
  const worker = new ProjectWorker(
    {} as never,
    {
      ITERATE_WORKER_VERSION: "test",
      ITX: { get },
    } as never,
  );

  await worker.processEventBatch({
    events: [
      {
        type: "events.iterate.com/project/worker-updated",
        path: "/",
        payload: { commitOid: "b".repeat(40) },
      },
      {
        type: "events.iterate.com/project/worker-updated",
        path: "/",
        payload: { commitOid: "c".repeat(40) },
      },
    ],
  } as never);

  expect(set).toHaveBeenCalledTimes(2);
  const configured = set.mock.calls[0]![0];
  expect(configured).toMatchObject({
    key: "iterate/config/heartbeat/every-15-minutes",
    recurrence: { every: 900 },
  });

  // Pin the exact source handed to the Scheduler; the Scheduler's own tests
  // prove that it invokes action strings with (itx, schedule, trigger).
  expect(configured.script).toContain('type: "events.iterate.com/project/heartbeat-triggered"');
  expect(configured.script).toContain(
    'idempotencyKey: "iterate/config/heartbeat:" + trigger.executionId',
  );
  expect(configured.script).toContain("payload: { scheduleKey: schedule.key }");

  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await deliver(worker, {
    type: "events.iterate.com/project/heartbeat-triggered",
    path: "/",
    payload: { scheduleKey: configured.key },
  });
  expect(log).toHaveBeenCalledWith("Project heartbeat fired", {
    scheduleKey: configured.key,
  });
  await deliver(worker, {
    type: "events.iterate.com/stream/woken",
    path: "/",
  });
  // Heartbeat and wake cases are independent literal hooks; neither silently
  // re-runs the worker-update case's Scheduler call.
  expect(set).toHaveBeenCalledTimes(2);

  const ignored = [
    {
      type: "events.iterate.com/project/create-requested",
      path: "/",
    },
    {
      type: "events.iterate.com/project/created",
      path: "/",
    },
    {
      type: "events.iterate.com/project/heartbeat-triggered",
      path: "/agents/not-the-project-root",
    },
    {
      type: "events.iterate.com/stream/woken",
      path: "/agents/not-the-project-root",
    },
    {
      type: "events.iterate.com/project/worker-updated",
      path: "/agents/not-the-project-root",
    },
  ];
  for (const event of ignored) await deliver(worker, event);
  expect(set).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledOnce();
});

test("packaged apps stay behind the thin router", () => {
  const worker = templateFile("worker.ts");
  expect(worker).not.toContain("rootDir");
  expect(worker).not.toContain("clientEntryPoint");
  expect(worker).not.toContain("pipeline:");
  expect(worker).not.toContain("tanstack");
  expect(worker).toContain('from "iterate/starter-apps/guestbook"');
  expect(worker).toContain("this.#guestbookApp.processEvent(event)");
  expect(worker).toContain("this.#guestbookApp.fetch(req)");
  expect(templateFile("apps/guestbook/server.tsx")).toContain(
    'from "iterate/starter-apps/guestbook/configured-worker"',
  );
  expect(templateFile("apps/guestbook/client.tsx")).toContain(
    'import "iterate/starter-apps/guestbook/client"',
  );
});

test.each([null, ""])(
  "the Docs proxy uses its production origin when the stored override is %j",
  async (configuredOrigin) => {
    const outboundFetch = vi.fn(async (request: Request) => new Response(request.url));
    vi.stubGlobal("fetch", outboundFetch);
    const project = {
      auth: {
        get: vi.fn(() => ({ fetch: vi.fn(async () => null) })),
      },
      kv: {
        get: vi.fn(async () => configuredOrigin),
      },
      [Symbol.dispose]: vi.fn(),
    };
    const worker = new ProjectWorker(
      {} as never,
      {
        ITERATE_WORKER_VERSION: "test",
        ITX: { get: vi.fn(async () => project) },
      } as never,
    );

    await worker.fetch(
      new Request(
        "https://docs--example.iterate.app/review?workspacePath=%2Fworkspaces%2Fdemo&file=brief.md",
        { headers: { "x-iterate-app": "docs" } },
      ),
    );

    expect(outboundFetch).toHaveBeenCalledOnce();
    expect(outboundFetch.mock.calls[0]![0].url).toBe(
      "https://docs.iterate.workers.dev/review?workspacePath=%2Fworkspaces%2Fdemo&file=brief.md",
    );
  },
);

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts frozen at seed time. Now
  // worker.ts imports straight from `iterate/sdk` and worker builds
  // npm-install the published package (pkg.pr.new's @main URL tracks the
  // latest build from main; preview deploys pin their PR's build through the
  // in-memory manifest rewrite).
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');
  expect(templateFile("worker.ts")).toContain('from "iterate/starter-apps/github-ai-linter"');
  expect(templateFile("worker.ts")).toContain('from "iterate/starter-apps/guestbook"');
  expect(templateFile("worker.ts")).toContain('from "iterate/starter-apps/todo"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});

test("seeded GitHub AI linter reads editable rules shipped in the config repo", () => {
  const rulePaths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path).filter((path) =>
    path.startsWith("rules/"),
  );
  expect(rulePaths).toEqual([
    "rules/structure/no-small-single-use-helper.md",
    "rules/typescript/explain-type-cast.md",
    "rules/typescript/no-inferable-type-annotation.md",
  ]);
  for (const rulePath of rulePaths) {
    expect(templateFile("worker.ts")).toContain(JSON.stringify(rulePath));
    expect(templateFile(rulePath)).toMatch(/^---\nid: [^\n]+\nseverity: error\n/);
  }
});
