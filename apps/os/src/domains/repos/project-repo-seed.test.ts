import { expect, test } from "vitest";
import { projectRepoSeedFiles, templateIterateRepoPkgSpecs } from "./project-repo-seed.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

const TEMPLATE_ITERATE_SPEC = "https://pkg.pr.new/iterate/iterate/iterate@main";

test("no knobs seed the template verbatim", () => {
  expect(projectRepoSeedFiles({})).toBe(PROJECT_REPO_INITIAL_FILES);
});

test("the seed keeps the root worker and hosted app proxies", () => {
  const worker = projectRepoSeedFiles({}).find((file) => file.path === "worker.ts");
  expect(worker?.content).toContain('if (app === "tasks")');
  expect(worker?.content).toContain('itx.kv.get("tasks-app-origin")');
  expect(worker?.content).toContain('"tasks.iterate.workers.dev"');
  expect(worker?.content).toContain('if (app === "docs")');
  expect(worker?.content).toContain('itx.kv.get("docs-app-origin")');
  expect(worker?.content).toContain('"https://docs.iterate.workers.dev"');
});

test("a ref pins every iterate/iterate pkg.pr.new spec in every manifest", () => {
  const sha = "d".repeat(40);
  const files = projectRepoSeedFiles({ iterateRepoPkgRef: sha });

  const packageJson = JSON.parse(files.find((file) => file.path === "package.json")!.content);
  expect(packageJson).toMatchObject({
    dependencies: { iterate: `https://pkg.pr.new/iterate/iterate/iterate@${sha}` },
  });

  // Every non-manifest file is untouched, and nothing still carries @main.
  const others = files.filter((file) => !file.path.endsWith("package.json"));
  expect(others).toEqual(
    PROJECT_REPO_INITIAL_FILES.filter((file) => !file.path.endsWith("package.json")),
  );
  expect(files.some((file) => file.content.includes(TEMPLATE_ITERATE_SPEC))).toBe(false);
});

test("a spec override replaces the named dependency wholesale (local dev tarball)", () => {
  const tarball = "http://127.0.0.1:4321/iterate-abc123.tgz";
  const files = projectRepoSeedFiles({ iterateRepoPkgSpecOverrides: { iterate: tarball } });

  const packageJson = JSON.parse(files.find((file) => file.path === "package.json")!.content);
  expect(packageJson).toMatchObject({ dependencies: { iterate: tarball } });
});

test("an override for a dependency the template does not carry fails loudly", () => {
  expect(() =>
    projectRepoSeedFiles({ iterateRepoPkgSpecOverrides: { "@iterate-com/nonexistent": "1.0.0" } }),
  ).toThrow(/@iterate-com\/nonexistent.*matched no template package\.json dependency/);
});

test("the template carries pinnable pkg.pr.new specs where the substitution looks", () => {
  // projectRepoSeedFiles throws at seed time if the template drifts away from
  // pkg.pr.new specs entirely; this catches the same drift at unit-test time.
  expect(templateIterateRepoPkgSpecs()).toEqual([TEMPLATE_ITERATE_SPEC]);
});
