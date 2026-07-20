import { expect, test } from "vitest";
import { projectRepoSeedFiles, TEMPLATE_ITERATE_PACKAGE_SPEC } from "./project-repo-seed.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

test("no override seeds the template verbatim", () => {
  expect(projectRepoSeedFiles(undefined)).toBe(PROJECT_REPO_INITIAL_FILES);
});

test("an override re-points the iterate dependency in every manifest that carries it", () => {
  const spec = "https://pkg.pr.new/iterate/iterate/iterate@1758";
  const files = projectRepoSeedFiles(spec);

  const packageJson = JSON.parse(files.find((file) => file.path === "package.json")!.content);
  expect(packageJson).toMatchObject({ devDependencies: { iterate: spec } });
  // Seeded apps keep `iterate` as a devDependency for typechecking/editor
  // support only — the platform injects the runtime virtual modules. Preview
  // still re-points every manifest so editors and typecheck see the PR build.
  for (const appManifest of ["apps/todos/package.json", "apps/guestbook/package.json"]) {
    const appPackageJson = JSON.parse(files.find((file) => file.path === appManifest)!.content);
    expect(appPackageJson).toMatchObject({ devDependencies: { iterate: spec } });
  }

  // Every non-manifest file is untouched, and nothing still carries @main.
  const others = files.filter((file) => !file.path.endsWith("package.json"));
  expect(others).toEqual(
    PROJECT_REPO_INITIAL_FILES.filter((file) => !file.path.endsWith("package.json")),
  );
  expect(files.some((file) => file.content.includes(TEMPLATE_ITERATE_PACKAGE_SPEC))).toBe(false);
});

test("the template's own spec matches what the substitution looks for", () => {
  // The guard inside projectRepoSeedFiles throws at seed time if the template
  // drifts; this catches the same drift at unit-test time instead.
  const packageJson = JSON.parse(
    PROJECT_REPO_INITIAL_FILES.find((file) => file.path === "package.json")!.content,
  );
  expect(packageJson).toMatchObject({
    devDependencies: { iterate: TEMPLATE_ITERATE_PACKAGE_SPEC },
  });
});
