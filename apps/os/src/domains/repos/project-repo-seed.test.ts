import { expect, test } from "vitest";
import {
  projectRepoSeedFiles,
  TEMPLATE_ITERATE_PACKAGE_SPEC,
  TEMPLATE_TASKS_PACKAGE_SPEC,
} from "./project-repo-seed.ts";
import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

test("no override seeds the template verbatim", () => {
  expect(projectRepoSeedFiles({ iterate: undefined, tasks: undefined })).toBe(
    PROJECT_REPO_INITIAL_FILES,
  );
});

test("the seed keeps the root worker and tasks app proxy", () => {
  const worker = projectRepoSeedFiles({ iterate: undefined, tasks: undefined }).find(
    (file) => file.path === "worker.ts",
  );
  expect(worker?.content).toContain('if (app === "tasks")');
  expect(worker?.content).toContain('from "@iterate-com/tasks"');
  expect(worker?.content).toContain("TasksApp.create(this.env");
});

test("preview overrides re-point both first-party packages", () => {
  const iterate = "https://pkg.pr.new/iterate/iterate@abc123";
  const tasks = "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@abc123";
  const files = projectRepoSeedFiles({ iterate, tasks });

  const packageJson = JSON.parse(files.find((file) => file.path === "package.json")!.content);
  expect(packageJson).toMatchObject({
    dependencies: { "@iterate-com/tasks": tasks, iterate },
  });

  // Every non-manifest file is untouched, and nothing still carries @main.
  const others = files.filter((file) => !file.path.endsWith("package.json"));
  expect(others).toEqual(
    PROJECT_REPO_INITIAL_FILES.filter((file) => !file.path.endsWith("package.json")),
  );
  expect(files.some((file) => file.content.includes(TEMPLATE_ITERATE_PACKAGE_SPEC))).toBe(false);
  expect(files.some((file) => file.content.includes(TEMPLATE_TASKS_PACKAGE_SPEC))).toBe(false);
});

test("the template's own spec matches what the substitution looks for", () => {
  // The guard inside projectRepoSeedFiles throws at seed time if the template
  // drifts; this catches the same drift at unit-test time instead.
  const packageJson = JSON.parse(
    PROJECT_REPO_INITIAL_FILES.find((file) => file.path === "package.json")!.content,
  );
  expect(packageJson).toMatchObject({
    dependencies: {
      "@iterate-com/tasks": TEMPLATE_TASKS_PACKAGE_SPEC,
      iterate: TEMPLATE_ITERATE_PACKAGE_SPEC,
    },
  });
});
