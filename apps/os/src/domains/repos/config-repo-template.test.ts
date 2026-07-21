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

test("template ships only the two deliberately basic app pairs", () => {
  // Vendor SDK surfaces are NOT seeded (built-ins live at
  // itx.integrations.<slug>), projects grow their own apps/ and
  // integrations/ by editing their repo, and the complete GitHub review
  // workflow is userspace code in worker.ts.
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  const appPaths = paths.filter((path) => path.startsWith("apps/"));
  expect(appPaths).toEqual([
    "apps/guestbook/client.tsx",
    "apps/guestbook/server.tsx",
    "apps/todo/client.tsx",
    "apps/todo/server.tsx",
  ]);
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("agents/"))).toEqual([]);
  expect(paths).not.toContain("github-reviews.ts");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // Throwaway PR #2175 adds only the package-installation proof dependency;
  // normal seeded runtime surfaces still use platform virtual modules.
  expect(templatePackageJson.dependencies).toEqual({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
  expect(templatePackageJson.devDependencies).toMatchObject({
    "@iterate-com/capnweb": expect.any(String),
  });
});

test("basic apps use one server entry, one client entry, and external browser imports", () => {
  for (const app of ["guestbook", "todo"]) {
    expect(templateFile(`apps/${app}/server.tsx`)).toContain('from "cloudflare:workers"');
    const client = templateFile(`apps/${app}/client.tsx`);
    expect(client).toContain('from "https://esm.sh/react@19.2.4"');
    expect(client).toContain('from "https://esm.sh/react-dom@19.2.4/client"');
    expect(client).toContain(`export function ${app === "todo" ? "Todo" : "Guestbook"}Client()`);
    expect(client).not.toContain("react/jsx-runtime");
    // Platform overlay injection owns the final response and skips CSP pages.
    expect(templateFile(`apps/${app}/server.tsx`)).not.toContain("content-security-policy");
  }

  const worker = templateFile("worker.ts");
  expect(worker.match(/createApp:/g)).toHaveLength(2);
  expect(worker.match(/client: "apps\/(?:todo|guestbook)\/client\.tsx"/g)).toHaveLength(2);
  expect(worker.match(/server: "apps\/(?:todo|guestbook)\/server\.tsx"/g)).toHaveLength(2);
  expect(worker).not.toContain("rootDir");
  expect(worker).not.toContain("clientEntryPoint");
  expect(worker).not.toContain("pipeline:");
  expect(worker).not.toContain("tanstack");
});

test("template gets the platform sdk from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts frozen at seed time. Now
  // worker.ts imports straight from `iterate/sdk`: types resolve through the
  // published package (pkg.pr.new's @main URL tracks the latest build from
  // main), and the RUNTIME imports are satisfied at build time by the
  // platform-injected virtual module (worker-loader.ts), never by npm.
  expect(templateFile("worker.ts")).toContain('from "iterate/sdk"');

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  // Throwaway PR #2175 deliberately makes this a runtime dependency so its
  // non-virtual proof export must install before the homepage can render.
  expect(templatePackageJson.dependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});
