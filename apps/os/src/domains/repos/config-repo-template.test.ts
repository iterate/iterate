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

test("template ships policy only — no seeded apps, integrations, or sdk snapshot", () => {
  // Vendor SDK surfaces are NOT seeded (built-ins live at
  // itx.integrations.<slug>), projects grow their own apps/ and
  // integrations/ by editing their repo, and the complete GitHub review
  // workflow is userspace code in worker.ts.
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  expect(paths.filter((path) => path.startsWith("apps/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // The platform-injected modules deliberately leave their real shared
  // runtimes external: the guestbook and iterate/processors share one zod,
  // while iterate/live-state and the user's RpcTargets share one Cap'n Web
  // runtime. React + TanStack Router back the tanstack SSR example app only —
  // ordinary npm dependencies the worker build installs, nothing
  // platform-injected.
  expect(templatePackageJson.dependencies).toEqual({
    "@iterate-com/capnweb": expect.any(String),
    "@tanstack/react-router": expect.any(String),
    react: expect.any(String),
    "react-dom": expect.any(String),
    zod: expect.any(String),
  });
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
