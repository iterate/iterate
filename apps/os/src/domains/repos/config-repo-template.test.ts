// Structural shape of the seeded config-repo template. Exact-string anchors
// on the template's SOURCE (class names, import lines, host-kind expressions,
// review-rule prose) were deliberately deleted — they are the docs/testing.md
// antipattern of a unit test re-asserting another artifact's fixtures.
// Behavior is proven where it runs: worker-build.e2e.test.ts edits and
// rebuilds a seeded worker, and the seeded-apps/github-review flows exercise
// the template live.
import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
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
