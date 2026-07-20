// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { expect, test } from "vitest";
import {
  guestbookAppRef,
  guestbookCreationEvents,
  guestbookPageSource,
  guestbookSubscriptionConfigVersion,
} from "../../../config-repo-template/apps/guestbook/src/guestbook-ref.ts";
import {
  tanstackPageSource,
  tanstackTodosRef,
} from "../../../config-repo-template/apps/tanstack/src/todos-ref.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template ships policy only — no seeded apps, integrations, or sdk snapshot", () => {
  // Vendor SDK surfaces are NOT seeded (built-ins live at
  // itx.integrations.<slug>), projects grow their own apps/ and
  // integrations/ by editing their repo, and the complete GitHub review
  // workflow is userspace code in worker.ts.
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  // The seeded apps: the React todo app at apps/tanstack and the guestbook
  // at apps/guestbook (each its own package.json; worker-bundler builds them
  // in-workerd). Everything else under apps/ is still the project's to grow.
  const appPaths = paths.filter((path) => path.startsWith("apps/"));
  expect(appPaths.length).toBeGreaterThan(0);
  expect(
    appPaths.every(
      (path) => path.startsWith("apps/tanstack/") || path.startsWith("apps/guestbook/"),
    ),
  ).toBe(true);
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // The platform-injected modules deliberately leave their real shared
  // runtimes external: iterate/live-state and the user's RpcTargets share
  // one Cap'n Web runtime, so the root worker build installs it. Everything
  // the seeded apps need (react, zod for the guestbook's processor contract)
  // lives in THEIR manifests — each app's worker-bundler install uses its
  // own production dependency tree.
  expect(templatePackageJson.dependencies).toEqual({
    "@iterate-com/capnweb": expect.any(String),
  });
});

test("React pages and stateful APIs have independent worker entries", () => {
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "apps/guestbook/src/guestbook-app.ts",
      "apps/guestbook/src/server.ts",
      "apps/guestbook/src/client.tsx",
      "apps/tanstack/src/todos-app.ts",
      "apps/tanstack/src/server.ts",
      "apps/tanstack/src/client.tsx",
    ]),
  );

  for (const [pageSource, statefulRef] of [
    [guestbookPageSource, guestbookAppRef],
    [tanstackPageSource, tanstackTodosRef],
  ] as const) {
    expect(pageSource.options.client).toBe("src/client.tsx");
    expect(pageSource.options.entryPoint).toBe("src/server.ts");
    expect(pageSource.options.minify).toBe(true);
    expect(pageSource.options).not.toHaveProperty("pipeline");
    expect(statefulRef.source.options).not.toHaveProperty("client");
    expect(statefulRef.source.options.entryPoint).not.toBe("worker.ts");
    expect(statefulRef.source.options.minify).toBe(true);
    expect(statefulRef.updatePolicy).toBe("stale-while-rebuild");
  }
});

test("guestbook wake delivery replaces the legacy subscription", () => {
  const subscription = guestbookCreationEvents()[1];

  // The legacy wake recipe can be retried after the repository has already
  // moved GuestbookApp out of its Vite build. It must not be able to poison
  // the new app's host facet under the old durable identity.
  expect(guestbookAppRef.durableWorkerKey).not.toBe("app-guestbook");
  expect(subscription).toMatchObject({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      subscriptionKey: "app-guestbook#guestbook",
      delivery: {
        mode: "wake",
        expression: ["workers", ["get", guestbookAppRef], "processor", "wakeStreamSubscriber"],
      },
    },
  });
  // The pre-split template committed the same subscription identity with
  // this append idempotency key. A distinct event must reach the stream's
  // replacement reducer while preserving its delivery cursor.
  expect(subscription?.idempotencyKey).not.toBe("guestbook/subscription");
  expect(subscription?.idempotencyKey).toBe(
    `guestbook/subscription:v${guestbookSubscriptionConfigVersion}`,
  );
});

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts frozen at seed time. Now
  // worker.ts imports straight from `iterate/sdk`: types resolve through the
  // published package (pkg.pr.new's @main URL tracks the latest build from
  // main), and the RUNTIME imports are satisfied at build time by the
  // platform-injected virtual module (worker-loader.ts), never by npm.
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    devDependencies: Record<string, string>;
  };
  expect(templatePackageJson.devDependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});
