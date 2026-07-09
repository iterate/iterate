import { expect, test } from "vitest";
import { projectRepoSeedFiles, TEMPLATE_ITERATE_PACKAGE_SPEC } from "./project-repo-seed.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

test("no override seeds the template verbatim", () => {
  expect(projectRepoSeedFiles(undefined)).toBe(PROJECT_REPO_INITIAL_FILES);
});

test("an override re-points the iterate dependency in package.json only", () => {
  const spec = "https://pkg.pr.new/iterate/iterate/iterate@1758";
  const files = projectRepoSeedFiles(spec);

  const packageJson = JSON.parse(files.find((file) => file.path === "package.json")!.content);
  expect(packageJson).toMatchObject({ dependencies: { iterate: spec } });

  // Every other file is untouched, and nothing still carries @main.
  const others = files.filter((file) => file.path !== "package.json");
  expect(others).toEqual(PROJECT_REPO_INITIAL_FILES.filter((file) => file.path !== "package.json"));
  expect(files.some((file) => file.content.includes(TEMPLATE_ITERATE_PACKAGE_SPEC))).toBe(false);
});

test("the template's own spec matches what the substitution looks for", () => {
  // The guard inside projectRepoSeedFiles throws at seed time if the template
  // drifts; this catches the same drift at unit-test time instead.
  const packageJson = JSON.parse(
    PROJECT_REPO_INITIAL_FILES.find((file) => file.path === "package.json")!.content,
  );
  expect(packageJson).toMatchObject({
    // A runtime dependency, not a devDependency: worker.ts imports the
    // stream-processor machinery from iterate/sdk, so the worker build
    // pipeline must install it.
    dependencies: { iterate: TEMPLATE_ITERATE_PACKAGE_SPEC },
  });
});
