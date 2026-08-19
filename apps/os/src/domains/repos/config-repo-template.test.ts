// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { afterEach, expect, test, vi } from "vitest";
import ProjectWorker from "../../../../../configs/default/worker.ts";
import VoiceProjectWorker from "../../../../../configs/with-voice/worker.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

afterEach(() => vi.unstubAllGlobals());

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

function pipelinedProject<Project extends object>(project: Project) {
  return Object.assign(Promise.resolve(project), project);
}

function deliver(
  worker: { processEventBatch(batch: never): Promise<void> },
  event: {
    type: string;
    path: string;
    payload?: Record<string, unknown>;
    source?: Record<string, unknown>;
  },
): Promise<void> {
  return worker.processEventBatch({ events: [event] } as never);
}

test.each([
  {
    name: "default",
    prompt: "Default onboarding instructions",
    start: "The project owner just created this project.",
    worker: (env: never) => new ProjectWorker({} as never, env),
  },
  {
    name: "with-voice",
    prompt: "Voice-specific onboarding instructions",
    start: "The project owner just created this voice project.",
    worker: (env: never) => new VoiceProjectWorker({} as never, env),
  },
])(
  "$name template owns onboarding agent creation, startup, and new-project client redirects",
  async ({ name, prompt, start, worker: makeWorker }) => {
    const create = vi.fn(async () => undefined);
    const append = vi.fn(async () => []);
    const landingTabCapability = vi.fn(
      async (call: { path: string[] }): Promise<string | undefined> =>
        call.path.at(-1) === "url"
          ? "https://os.iterate.test/projects/new-project?welcome=true"
          : undefined,
    );
    const busyTabCapability = vi.fn(
      async (): Promise<string> => "https://os.iterate.test/projects/new-project/repl",
    );
    const project = {
      agents: {
        get: vi.fn(() => ({ append, create })),
      },
      clients: {
        get: vi.fn((path: string) => ({
          __describe: vi.fn(async () => ({ capabilities: [{ path: ["capabilities"] }] })),
          invokeCapability:
            path === "/clients/os-app/landing-tab" ? landingTabCapability : busyTabCapability,
        })),
        list: vi.fn(async () => [
          {
            path: "/clients/os-app/landing-tab",
            connected: true,
            lastConnectedAt: "2026-08-07T10:00:00.000Z",
          },
          {
            path: "/clients/os-app/busy-tab",
            connected: true,
            lastConnectedAt: "2026-08-07T10:00:00.000Z",
          },
          {
            path: "/clients/os-app/closed-tab",
            connected: false,
            lastConnectedAt: "2026-08-07T09:00:00.000Z",
          },
          {
            path: "/clients/terminal",
            connected: true,
            lastConnectedAt: "2026-08-07T10:00:00.000Z",
          },
        ]),
      },
      identity: vi.fn(async () => ({ slug: "new-project" })),
      repo: {
        readFile: vi.fn(async () => ({ content: prompt })),
      },
      [Symbol.dispose]: vi.fn(),
    };
    const instance = makeWorker({
      ITERATE_WORKER_VERSION: "test",
      ITX: { get: vi.fn(() => pipelinedProject(project)) },
    } as never);

    await deliver(instance, {
      type: "events.iterate.com/project/created",
      path: "/",
      payload: {
        config: {
          slug: "new-project",
          configRepoTemplate: `github:iterate/iterate#main&path:configs/${name}`,
        },
        createRequestedAtOffset: 4,
      },
    });

    expect(create).toHaveBeenCalledExactlyOnceWith();
    expect(append).toHaveBeenCalledWith(
      {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: "iterate/config/onboarding-instructions:v1",
        payload: {
          role: "system",
          key: "config/onboarding-instructions",
          content: prompt,
          llmRequestPolicy: { behaviour: "dont-trigger-request" },
        },
      },
      expect.objectContaining({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: "iterate/config/onboarding-start:v1",
        payload: expect.objectContaining({
          role: "developer",
          key: "config/onboarding-start",
          content: expect.stringContaining(start),
          llmRequestPolicy: { behaviour: "after-current-request" },
        }),
      }),
    );
    expect(project.clients.get).toHaveBeenCalledTimes(name === "with-voice" ? 4 : 2);
    expect(project.clients.get).toHaveBeenCalledWith("/clients/os-app/landing-tab");
    expect(project.clients.get).toHaveBeenCalledWith("/clients/os-app/busy-tab");
    expect(landingTabCapability).toHaveBeenNthCalledWith(1, {
      path: ["capabilities", "browser", "url"],
    });
    expect(landingTabCapability).toHaveBeenNthCalledWith(2, {
      path: ["capabilities", "browser", "navigate"],
      args: ["/projects/new-project/agents/streams/agents/onboarding"],
    });
    expect(busyTabCapability).toHaveBeenCalledExactlyOnceWith({
      path: ["capabilities", "browser", "url"],
    });
  },
);

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
    // A worked example of a userspace processor hosted as a facet, with
    // recovery — see the app's own header and example-agent-recovery.e2e.test.ts.
    "apps/example-agent/example-agent.ts",
    "apps/example-agent/tsconfig.json",
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
    "@iterate-com/docs": expect.any(String),
    iterate: expect.any(String),
    react: expect.any(String),
    zod: expect.any(String),
  });
});

test("project lifecycle cases directly install and handle the default heartbeat", async () => {
  const set = vi.fn(async (input: { key: string; recurrence: unknown; script: string }) => input);
  const append = vi.fn(async (input: unknown) => [input]);
  const project = {
    repos: { list: async () => [] },
    repo: {
      readFile: async (input: { path: string }) =>
        input.path === "prompts/agent-system-prompt.md" ? { content: "PROMPT TEXT\n" } : null,
    },
    streams: { get: () => ({ append }) },
    scheduler: { set },
    // The MediaApp glue mounts itx.media on worker-updated.
    capabilityHosts: { get: () => ({ provideCapability: async () => null }) },
    [Symbol.dispose]: vi.fn(),
  };
  const get = vi.fn(() => pipelinedProject(project));
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

  // Worker-updated appends nothing: agent configuration is a REACTION to
  // each agent/created (see the birth-reaction test below), not a standing
  // publish.
  expect(append).not.toHaveBeenCalled();

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

test("the birth reaction shapes each newborn and lowers the debounce as its last word", async () => {
  const makeReactionWorker = (promptFileContent: string) => {
    const append = vi.fn(async (...events: unknown[]) => events);
    const snapshot = vi.fn(async () => ({
      state: {
        contextItems: [
          // The platform's embedded prompt slot, newline-stripped at birth.
          { offset: 5, payload: { key: "agent/system-prompt", content: "PROMPT TEXT" } },
        ],
      },
    }));
    const project = {
      repo: {
        readFile: vi.fn(async (input: { path: string }) => {
          if (input.path === "prompts/agent-system-prompt.md")
            return { content: promptFileContent };
          if (input.path === "AGENTS.md") return { content: "Project notes." };
          return null;
        }),
      },
      agents: { get: vi.fn(() => ({ append, processor: { snapshot } })) },
      [Symbol.dispose]: vi.fn(),
    };
    const worker = new ProjectWorker(
      {} as never,
      {
        ITERATE_WORKER_VERSION: "test",
        ITX: { get: vi.fn(() => pipelinedProject(project)) },
      } as never,
    );
    return { worker, append, project };
  };

  // Unforked prompt file (byte-identical to the platform's embedded copy):
  // no supersession — just the AGENTS.md sync, the house style, and the
  // debounce lowered LAST (the done-configuring signal).
  const unforked = makeReactionWorker("PROMPT TEXT\n");
  await deliver(unforked.worker, {
    type: "events.iterate.com/agent/created",
    path: "/agents/demo",
    payload: {},
  });
  expect(unforked.project.agents.get).toHaveBeenCalledWith("/agents/demo");
  const unforkedEvents = unforked.append.mock.calls.flat() as {
    type: string;
    payload: Record<string, unknown>;
  }[];
  expect(unforkedEvents.map((event) => event.payload.key || event.type)).toEqual([
    "config/agents-md",
    "config/house-style",
    "events.iterate.com/agent/configured",
  ]);
  expect(unforkedEvents.at(-1)).toMatchObject({
    type: "events.iterate.com/agent/configured",
    idempotencyKey: "iterate/config/agent-birth-configured:v1",
    payload: { config: { llmRequestDebounceMs: 250 } },
  });

  // Forked prompt file: the repo's version supersedes the platform slot.
  const forked = makeReactionWorker("FORKED PROMPT\n");
  await deliver(forked.worker, {
    type: "events.iterate.com/agent/created",
    path: "/agents/demo",
    payload: {},
  });
  const forkedEvents = forked.append.mock.calls.flat() as {
    type: string;
    payload: Record<string, unknown>;
  }[];
  expect(forkedEvents.find((event) => event.payload.key === "agent/system-prompt")).toMatchObject({
    payload: { content: "FORKED PROMPT", role: "system" },
  });

  // Copies to the collection stream never re-trigger the reaction.
  const copied = makeReactionWorker("PROMPT TEXT\n");
  await deliver(copied.worker, {
    type: "events.iterate.com/agent/created",
    path: "/agents",
    payload: {},
    source: { copiedFrom: { path: "/agents/demo", offset: 1 } },
  });
  expect(copied.append).not.toHaveBeenCalled();
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
        ITX: { get: vi.fn(() => pipelinedProject(project)) },
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

test("the project auth helper leaves a declined request body for the app", async () => {
  const authFetch = vi.fn(async (_request: Request) => null);
  const todoFetch = vi.fn(async (request: Request) => new Response(await request.text()));
  const project = {
    auth: { get: vi.fn(() => ({ fetch: authFetch })) },
    [Symbol.dispose]: vi.fn(),
  };
  const worker = new ProjectWorker(
    {} as never,
    {
      ITERATE_WORKER_VERSION: "test",
      ITX: {
        fetch: todoFetch,
        get: vi.fn(() => pipelinedProject(project)),
      },
    } as never,
  );
  const request = new Request("https://todo--example.iterate.app/items", {
    body: "still here",
    headers: { "content-type": "text/plain", "x-iterate-app": "todo" },
    method: "POST",
  });

  await expect(worker.fetch(request).then((response) => response.text())).resolves.toBe(
    "still here",
  );
  expect(authFetch).toHaveBeenCalledOnce();
  const authRequest = authFetch.mock.calls[0]![0];
  expect(authRequest).not.toBe(request);
  expect(authRequest.body).toBeNull();
  expect(authRequest.method).toBe("POST");
  expect(authRequest.url).toBe("https://todo--example.iterate.app/items");
  expect(Object.fromEntries(authRequest.headers)).toEqual({
    "content-type": "text/plain",
    "x-iterate-app": "todo",
  });
});

test("the project auth helper transfers the callback POST that auth owns", async () => {
  const appFetch = vi.fn();
  const authFetch = vi.fn(async (request: Request) => new Response(await request.text()));
  const project = {
    auth: { get: vi.fn(() => ({ fetch: authFetch })) },
    [Symbol.dispose]: vi.fn(),
  };
  const worker = new ProjectWorker(
    {} as never,
    {
      ITERATE_WORKER_VERSION: "test",
      ITX: {
        fetch: appFetch,
        get: vi.fn(() => pipelinedProject(project)),
      },
    } as never,
  );
  const request = new Request("https://todo--example.iterate.app/_iterate/auth/callback", {
    body: "auth token",
    headers: { "x-iterate-app": "todo" },
    method: "POST",
  });

  await expect(worker.fetch(request).then((response) => response.text())).resolves.toBe(
    "auth token",
  );
  expect(authFetch).toHaveBeenCalledExactlyOnceWith(request);
  expect(appFetch).not.toHaveBeenCalled();
});

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
  expect(templateFile("worker.ts")).toContain('from "@iterate-com/docs"');
  expect(templateFile("worker.ts")).toContain("get docs()");
  expect(templateFile("worker.ts")).toContain("return this.#docsApp.rpc");
  // The tasks board is the /w view of the ONE app: docs.link mints both
  // views, so there is no tasks getter, host branch, or proxy.
  expect(templateFile("worker.ts")).not.toContain("get tasks()");
  expect(templateFile("worker.ts")).not.toContain('if (app === "tasks")');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(templatePackageJson.dependencies).toMatchObject({
    "@iterate-com/docs": "https://pkg.pr.new/iterate/iterate/@iterate-com/docs@main",
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
