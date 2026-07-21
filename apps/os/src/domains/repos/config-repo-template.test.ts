// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { expect, test } from "vitest";
import {
  counterAppRef,
  guestbookAppRef,
  helloAppRef,
  internalAppRef,
  todoAppRef,
} from "../../../config-repo-template/worker.ts";
import { CounterApp } from "../../../config-repo-template/apps/counter/src/counter-app.ts";
import { GuestbookApp } from "../../../config-repo-template/apps/guestbook/server.tsx";
import { HelloApp } from "../../../config-repo-template/apps/hello/src/hello-app.ts";
import { InternalApp } from "../../../config-repo-template/apps/internal/src/internal-app.ts";
import { ReviewBotApp } from "../../../config-repo-template/apps/review-bot/src/review-bot-app.ts";
import {
  reviewBotAppRef,
  reviewBotSubscriptionConfigVersion,
  reviewBotSubscriptionEvents,
} from "../../../config-repo-template/apps/review-bot/src/review-bot-ref.ts";
import { ReviewBotProcessorContract } from "../../../config-repo-template/apps/review-bot/src/review-bot.ts";
import { TodoApp } from "../../../config-repo-template/apps/todo/server.tsx";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
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
        path.startsWith("apps/hello/") ||
        path.startsWith("apps/internal/") ||
        path.startsWith("apps/counter/") ||
        path.startsWith("apps/todo/") ||
        path.startsWith("apps/guestbook/") ||
        path.startsWith("apps/review-bot/"),
    ),
  ).toBe(true);
  expect(paths).toEqual(
    expect.arrayContaining([
      "apps/hello/src/hello-app.ts",
      "apps/internal/src/internal-app.ts",
      "apps/counter/src/counter-app.ts",
      "apps/review-bot/src/review-bot-app.ts",
      "apps/todo/client.tsx",
      "apps/todo/server.tsx",
      "apps/guestbook/client.tsx",
      "apps/guestbook/processor.ts",
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

test("browser pairs stay two-file createApp apps behind the thin router", () => {
  const worker = templateFile("worker.ts");
  expect(worker.match(/createApp:/g)).toHaveLength(2);
  expect(worker.match(/client: "apps\/(?:todo|guestbook)\/client\.tsx"/g)).toHaveLength(2);
  expect(worker.match(/server: "apps\/(?:todo|guestbook)\/server\.tsx"/g)).toHaveLength(2);
  expect(worker).not.toContain("rootDir");
  expect(worker).not.toContain("clientEntryPoint");
  expect(worker).not.toContain("pipeline:");
  expect(worker).not.toContain("tanstack");
});

test("modular createWorker refs point at apps/ entrypoints, not the root worker file", () => {
  expect(helloAppRef.source.createWorker.entryPoint).toBe("apps/hello/src/hello-app.ts");
  expect(internalAppRef.source.createWorker.entryPoint).toBe("apps/internal/src/internal-app.ts");
  expect(counterAppRef.source.createWorker.entryPoint).toBe("apps/counter/src/counter-app.ts");
  expect(reviewBotAppRef("install-789").source.createWorker.entryPoint).toBe(
    "apps/review-bot/src/review-bot-app.ts",
  );
  expect("createApp" in todoAppRef.source).toBe(true);
  expect("createApp" in guestbookAppRef.source).toBe(true);
});

test("app modules load and export the classes their refs name", () => {
  // Importing every entry module HERE keeps the whole set in the vitest load
  // path (they must evaluate under the cloudflare:workers shim) and pins each
  // ref's entrypoint/className string to the class the entry module actually
  // exports — a rename can never strand a persisted ref or wake expression
  // pointing at a class the build no longer exports.
  expect(helloAppRef.entrypoint).toBe(HelloApp.name);
  expect(internalAppRef.entrypoint).toBe(InternalApp.name);
  expect(counterAppRef.className).toBe(CounterApp.name);
  expect(reviewBotAppRef("install-789").className).toBe(ReviewBotApp.name);
  expect(todoAppRef.className).toBe(TodoApp.name);
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
