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

test("template ships live-state todo and stream-processor guestbook", () => {
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  const appPaths = paths.filter((path) => path.startsWith("apps/")).toSorted();
  expect(appPaths).toEqual([
    "apps/guestbook/client.tsx",
    "apps/guestbook/host.ts",
    "apps/guestbook/processor.ts",
    "apps/guestbook/ref.ts",
    "apps/guestbook/server.tsx",
    "apps/todo/client.tsx",
    "apps/todo/host.ts",
    "apps/todo/server.tsx",
  ]);
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // Guestbook processor contract needs zod at createWorker install time;
  // everything else is platform virtual modules.
  expect(templatePackageJson.dependencies).toMatchObject({
    zod: expect.any(String),
  });
  expect(templatePackageJson.devDependencies).toMatchObject({
    "@iterate-com/capnweb": expect.any(String),
  });
});

test("todo and guestbook use Cap'n Web live state clients and createWorker hosts", () => {
  // Page shells stay createApp + external React for the browser.
  for (const app of ["guestbook", "todo"]) {
    expect(templateFile(`apps/${app}/client.tsx`)).toContain('from "https://esm.sh/react@19.2.4"');
    expect(templateFile(`apps/${app}/client.tsx`)).toContain("useLiveStateRpc");
    expect(templateFile(`apps/${app}/client.tsx`)).toContain("newWebSocketRpcSession");
    expect(templateFile(`apps/${app}/server.tsx`)).toContain('from "cloudflare:workers"');
  }

  expect(templateFile("apps/todo/host.ts")).toContain("extends IterateDurableObject");
  expect(templateFile("apps/todo/host.ts")).toContain("LiveState");
  expect(templateFile("apps/todo/server.tsx")).toContain("TodoPage");

  expect(templateFile("apps/guestbook/host.ts")).toContain("extends IterateDurableObject");
  expect(templateFile("apps/guestbook/processor.ts")).toContain('slug: "guestbook"');
  expect(templateFile("apps/guestbook/processor.ts")).toContain("extends StreamProcessor");
  expect(templateFile("apps/guestbook/ref.ts")).toContain('guestbookStreamPath = "/guestbook"');
  expect(templateFile("apps/guestbook/ref.ts")).toContain("createWorker:");

  const worker = templateFile("worker.ts");
  expect(worker).toContain("todoHostRef");
  expect(worker).toContain("guestbookHostRef");
  expect(worker).toContain('pathname.startsWith("/api")');
  expect(worker).toContain("stream processor reduce on /guestbook");
  expect(worker).not.toContain("rootDir");
  expect(worker).not.toContain("pipeline:");
  expect(worker).not.toContain("tanstack");
});

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    devDependencies: Record<string, string>;
  };
  expect(templatePackageJson.devDependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});
