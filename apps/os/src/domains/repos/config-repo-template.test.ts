import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

function templateFile(path: string): string {
  return PROJECT_REPO_INITIAL_FILES.find((file) => file.path === path)!.content;
}

test("template is one worker file with no vendor SDK cruft", () => {
  // The whole seeded worker lives in worker.ts — the router (default export)
  // plus the example apps as named exports — so reading one module is reading
  // the whole system. Vendor SDK surfaces are NOT seeded: built-ins live at
  // itx.integrations.<slug>, and a project that wants its own updates its own
  // worker first (worker-build.e2e.test.ts walks exactly that path).
  const paths = PROJECT_REPO_INITIAL_FILES.map((file) => file.path);
  expect(paths).not.toContain("sdk.ts");
  expect(paths.filter((path) => path.startsWith("apps/"))).toEqual([]);
  expect(paths.filter((path) => path.startsWith("integrations/"))).toEqual([]);

  const worker = templateFile("worker.ts");
  expect(worker).toContain("export default class ProjectWorker");
  expect(worker).toContain("export class HelloApp");
  expect(worker).toContain("export class CounterApp");
  expect(worker).not.toMatch(/slack/i);
  expect(worker).not.toMatch(/waitrose/i);

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    dependencies: Record<string, string>;
  };
  expect(templatePackageJson.dependencies).toEqual({});
});

test("template gets the platform types from iterate/sdk, not a committed snapshot", () => {
  // Seeded repos used to carry a 2000-line sdk.ts, a copy of the itx contract
  // frozen at seed time (later a small runtime companion). Now worker.ts
  // imports its types straight from the published `iterate` package —
  // pkg.pr.new's @main URL resolves to the latest build published from main
  // (.github/workflows/pkg-pr-new.yml), so `npm install` in a seeded repo
  // always gets the contract the platform currently speaks — and the batch
  // unpacking the old IterateProjectWorker base class did is inlined as
  // processEventBatch on the worker itself.
  const worker = templateFile("worker.ts");
  expect(worker).toContain('from "iterate/sdk"');
  expect(worker).toContain("async processEventBatch(");

  const templatePackageJson = JSON.parse(templateFile("package.json")) as {
    devDependencies: Record<string, string>;
  };
  expect(templatePackageJson.devDependencies).toMatchObject({
    iterate: "https://pkg.pr.new/iterate/iterate/iterate@main",
  });
});

test("template app links use custom-domain subdomains only for custom host routes", () => {
  const worker = templateFile("worker.ts");

  expect(worker).toContain('req.headers.get("x-iterate-host-kind")');
  expect(worker).toContain(
    'hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`',
  );
});
