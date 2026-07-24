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
} from "../../../config-repo-template/apps/guestbook/ref.ts";
import { GuestbookProcessorContract } from "../../../config-repo-template/apps/guestbook/processor.ts";
import { GuestbookApp } from "../../../config-repo-template/apps/guestbook/server.tsx";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template ships project-owned apps under apps/ and packaged apps behind a thin router", () => {
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
  expect(appPaths.length).toBeGreaterThan(0);
  expect(appPaths.every((path) => path.startsWith("apps/guestbook/"))).toBe(true);
  expect(paths.filter((path) => path.startsWith("apps/todo/"))).toEqual([]);
  expect(paths).toEqual(
    expect.arrayContaining([
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
  // its `iterate` spec in-memory per deploy), so every project-owned app's
  // runtime deps live here, never in per-app manifests the rewrite would miss.
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: expect.any(String),
    react: expect.any(String),
    zod: expect.any(String),
  });
});

test("the project-owned browser pair stays behind the thin router", () => {
  // The packaged Todo owns its client and stateful worker. The guestbook ref
  // is shared with its wake subscription, so it stays assertable here.
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

test("modular createApp refs point at apps/ entrypoints, not the root worker file", () => {
  expect("createApp" in guestbookAppRef.source).toBe(true);
});

test("app modules load and export the classes their refs name", () => {
  // Importing every entry module HERE keeps the whole set in the vitest load
  // path (they must evaluate under the cloudflare:workers shim) and pins each
  // ref's entrypoint/className string to the class the entry module actually
  // exports — a rename can never strand a persisted ref or wake expression
  // pointing at a class the build no longer exports.
  expect(guestbookAppRef.className).toBe(GuestbookApp.name);
});

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts frozen at seed time. Now
  // worker.ts imports straight from `iterate/sdk` and worker builds
  // npm-install the published package (pkg.pr.new's @main URL tracks the
  // latest build from main; preview deploys pin their PR's build through the
  // in-memory manifest rewrite).
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');
  expect(templateFile("worker.ts")).toContain('from "iterate/github-ai-linter"');
  expect(templateFile("worker.ts")).toContain('from "iterate/todo"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});

test("seeded GitHub AI linter reads editable rules shipped in the config repo", () => {
  expect(templateFile("worker.ts")).toContain(
    'glob: "rules/**/*.md",\n      repoPath: "/repos/config"',
  );

  const rulePaths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path).filter((path) =>
    path.startsWith("rules/"),
  );
  expect(rulePaths).toEqual([
    "rules/structure/no-small-single-use-helper.md",
    "rules/typescript/explain-type-cast.md",
    "rules/typescript/no-inferable-type-annotation.md",
  ]);
});
