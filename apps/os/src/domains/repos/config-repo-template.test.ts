// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { expect, test, vi } from "vitest";
import ProjectWorker from "../../../config-repo-template/worker.ts";
import {
  guestbookAppRef,
  guestbookCreationEvents,
} from "../../../config-repo-template/apps/guestbook/ref.ts";
import { GuestbookProcessorContract } from "../../../config-repo-template/apps/guestbook/processor.ts";
import { GuestbookApp } from "../../../config-repo-template/apps/guestbook/server.tsx";
import { ReviewBotApp } from "../../../config-repo-template/apps/review-bot/src/review-bot-app.ts";
import {
  reviewBotAppRef,
  reviewBotSubscriptionConfigVersion,
  reviewBotSubscriptionEvents,
} from "../../../config-repo-template/apps/review-bot/src/review-bot-ref.ts";
import { ReviewBotProcessorContract } from "../../../config-repo-template/apps/review-bot/src/review-bot.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

function deliver(
  worker: ProjectWorker,
  event: {
    type: string;
    path: string;
    payload?: Record<string, unknown>;
    source?: {
      crossPostedFrom?: Array<{
        subscriptionKey: string;
        createdAt: string;
        offset: number;
        path: string;
        projectId: string | null;
        type: string;
      }>;
    };
  },
): Promise<void> {
  return worker.processEventBatch({ events: [event] } as never);
}

test("template ships modular apps under apps/ and a thin worker router", () => {
  // Vendor SDK surfaces are NOT seeded (built-ins live at
  // itx.integrations.<slug>), projects grow their own apps/ and
  // integrations/ by editing their repo, and the complete GitHub review
  // workflow is userspace code in apps/review-bot.
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");

  const appPaths = paths.filter((path) => path.startsWith("apps/"));
  expect(appPaths.length).toBeGreaterThan(0);
  expect(
    appPaths.every(
      (path) =>
        path.startsWith("apps/todo/") ||
        path.startsWith("apps/guestbook/") ||
        path.startsWith("apps/review-bot/"),
    ),
  ).toBe(true);
  expect(paths).toEqual(
    expect.arrayContaining([
      "apps/review-bot/src/review-bot-app.ts",
      "apps/todo/client.tsx",
      "apps/todo/server.tsx",
      "apps/guestbook/client.tsx",
      "apps/guestbook/processor.ts",
      "apps/guestbook/ref.ts",
      "apps/guestbook/server.tsx",
    ]),
  );

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // Worker builds npm-install from the ROOT manifest (the platform rewrites
  // its `iterate` spec in-memory per deploy), so every app's runtime deps —
  // the review bot's zod included — live here, never in per-app manifests
  // the rewrite would miss.
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: expect.any(String),
    react: expect.any(String),
    zod: expect.any(String),
  });
});

test("project reconciliation ensures desired heartbeats and removes only stale owned keys", async () => {
  const obsolete = {
    key: "iterate/config/heartbeat/obsolete",
    recurrence: { every: 5 },
    action: { kind: "itx-script", script: "async () => {}" },
  };
  const unrelated = {
    key: "customer/daily-report",
    recurrence: { every: 86_400 },
    action: { kind: "itx-script", script: "async () => {}" },
  };
  const list = vi
    .fn()
    .mockResolvedValueOnce([obsolete, unrelated])
    .mockResolvedValueOnce([unrelated])
    .mockResolvedValueOnce([unrelated])
    .mockResolvedValueOnce([unrelated]);
  const ensure = vi.fn(
    async (input: { key: string; recurrence: unknown; script: string }) => input,
  );
  const cancel = vi.fn(async () => undefined);
  const dispose = vi.fn();
  const project = {
    scheduler: { cancel, ensure, list },
    [Symbol.dispose]: dispose,
  };
  const worker = new ProjectWorker(
    {} as never,
    {
      ITERATE_WORKER_VERSION: "test",
      ITX: { get: async () => project },
    } as never,
  );

  await deliver(worker, {
    type: "events.iterate.com/project/create-requested",
    path: "/",
  });

  expect(ensure).toHaveBeenCalledOnce();
  const configured = ensure.mock.calls[0]![0];
  expect(configured).toMatchObject({
    key: "iterate/config/heartbeat/every-15-minutes",
    recurrence: { every: 900 },
  });
  expect(cancel).toHaveBeenCalledExactlyOnceWith("iterate/config/heartbeat/obsolete");
  expect(cancel).not.toHaveBeenCalledWith("customer/daily-report");

  // Reconciliation always states the desired definition through ensure();
  // the Scheduler owns exact equality and preserves an unchanged clock.
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await deliver(worker, {
    type: "events.iterate.com/project/reconciliation-requested",
    path: "/",
    payload: { scheduleKey: configured.key },
  });
  expect(ensure).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("Project heartbeat fired", {
    scheduleKey: configured.key,
  });

  await deliver(worker, {
    type: "events.iterate.com/stream/woken",
    path: "/",
  });
  expect(ensure).toHaveBeenCalledTimes(3);
  expect(ensure.mock.calls[2]![0]).not.toHaveProperty("metadata");

  await deliver(worker, {
    type: "events.iterate.com/repo/commit-completed",
    path: "/",
    source: {
      crossPostedFrom: [
        {
          subscriptionKey: "cross-post:/",
          createdAt: new Date(1).toISOString(),
          offset: 1,
          path: "/repos/config",
          projectId: "prj_test",
          type: "events.iterate.com/repo/commit-completed",
        },
      ],
    },
  });
  expect(ensure).toHaveBeenCalledTimes(4);

  // Pin the exact source handed to the Scheduler; the Scheduler's own tests
  // prove that it invokes action strings with (itx, schedule, trigger).
  expect(configured.script).toBe(`async (itx, schedule, trigger) => {
  await itx.streams.get("/").append({
    type: "events.iterate.com/project/reconciliation-requested",
    idempotencyKey: "iterate/config/heartbeat:" + trigger.executionId,
    payload: { scheduleKey: schedule.key },
  });
}`);
  expect(dispose).toHaveBeenCalledTimes(4);

  const ignored = [
    {
      type: "events.iterate.com/project/create-requested",
      path: "/agents/not-the-project-root",
    },
    {
      type: "events.iterate.com/project/reconciliation-requested",
      path: "/agents/not-the-project-root",
    },
    {
      type: "events.iterate.com/stream/woken",
      path: "/agents/not-the-project-root",
    },
    {
      type: "events.iterate.com/repo/commit-completed",
      path: "/",
    },
    {
      type: "events.iterate.com/repo/commit-completed",
      path: "/",
      source: {
        crossPostedFrom: [
          {
            subscriptionKey: "wrong-rule",
            createdAt: new Date(1).toISOString(),
            offset: 1,
            path: "/repos/config",
            projectId: "prj_test",
            type: "events.iterate.com/repo/commit-completed",
          },
        ],
      },
    },
    {
      type: "events.iterate.com/repo/commit-completed",
      path: "/",
      source: {
        crossPostedFrom: [
          {
            subscriptionKey: "cross-post:/",
            createdAt: new Date(1).toISOString(),
            offset: 1,
            path: "/repos/config",
            projectId: "prj_test",
            type: "events.iterate.com/repo/different",
          },
        ],
      },
    },
  ];
  for (const event of ignored) await deliver(worker, event);
  expect(list).toHaveBeenCalledTimes(4);
});

test("browser pairs stay two-file createApp apps behind the thin router", () => {
  // The todo ref is inlined in worker.ts (one consumer); its rename risk is
  // covered live by the seeded-apps spec. The guestbook ref is shared with
  // its wake subscription, so it stays assertable.
  expect(guestbookAppRef.source.createApp).toMatchObject({
    client: "apps/guestbook/client.tsx",
    server: "apps/guestbook/server.tsx",
  });
  const worker = templateFile("worker.ts");
  expect(worker).not.toContain("rootDir");
  expect(worker).not.toContain("clientEntryPoint");
  expect(worker).not.toContain("pipeline:");
  expect(worker).not.toContain("tanstack");
});

test("guestbook wake subscription names the hosted processor", () => {
  const subscription = guestbookCreationEvents()[1];
  expect(subscription).toMatchObject({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "app-guestbook#guestbook",
      delivery: {
        mode: "wake",
        expression: ["workers", ["get", guestbookAppRef], "processor", "wakeStreamSubscriber"],
        // ref.ts is dependency-free, so it repeats the slug as a string;
        // this is the drift guard.
        processorSlug: GuestbookProcessorContract.slug,
      },
    },
  });
});

test("modular createWorker refs point at apps/ entrypoints, not the root worker file", () => {
  expect(reviewBotAppRef("install-789").source.createWorker.entryPoint).toBe(
    "apps/review-bot/src/review-bot-app.ts",
  );
  expect("createApp" in guestbookAppRef.source).toBe(true);
});

test("app modules load and export the classes their refs name", () => {
  // Importing every entry module HERE keeps the whole set in the vitest load
  // path (they must evaluate under the cloudflare:workers shim) and pins each
  // ref's entrypoint/className string to the class the entry module actually
  // exports — a rename can never strand a persisted ref or wake expression
  // pointing at a class the build no longer exports.
  expect(reviewBotAppRef("install-789").className).toBe(ReviewBotApp.name);
  expect(guestbookAppRef.className).toBe(GuestbookApp.name);
});

test("review-bot wake subscriptions are per-connection and name the hosted processor", () => {
  // Webhook streams are per connection and a wake subscription names one
  // exact stream, so the durable identity must fork per connection — two
  // connections sharing one host would fence on mismatched registry
  // coordinates.
  expect(reviewBotAppRef("install-789").durableWorkerKey).not.toBe(
    reviewBotAppRef("install-999").durableWorkerKey,
  );

  const [subscription] = reviewBotSubscriptionEvents("install-789");
  expect(subscription).toMatchObject({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "app-review-bot#review-bot",
      delivery: {
        mode: "wake",
        expression: [
          "workers",
          ["get", reviewBotAppRef("install-789")],
          "processor",
          "wakeStreamSubscriber",
        ],
        // The ref module is dependency-free, so it repeats the slug as a
        // string; this is the drift guard — a mismatch would make the spine
        // wake a processor slug the host never registered.
        processorSlug: ReviewBotProcessorContract.slug,
      },
    },
    idempotencyKey: `review-bot/subscription:v${reviewBotSubscriptionConfigVersion}`,
  });
});

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts frozen at seed time. Now
  // worker.ts imports straight from `iterate/sdk` and worker builds
  // npm-install the published package (pkg.pr.new's @main URL tracks the
  // latest build from main; preview deploys pin their PR's build through the
  // in-memory manifest rewrite).
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});
