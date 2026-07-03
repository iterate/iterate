import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.ts";

test("template @slack/web-api range matches the apps/os devDependency", () => {
  // The host copy exists only so the template folder typechecks under
  // apps/os; the version that actually RUNS is installed by the worker build
  // pipeline from the template's own package.json. Keeping the two ranges
  // equal keeps typecheck and runtime looking at the same SDK.
  const templatePackageJson = JSON.parse(
    PROJECT_REPO_INITIAL_FILES.find((file) => file.path === "package.json")!.content,
  ) as { dependencies: Record<string, string> };
  const hostPackageJson = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };

  expect(templatePackageJson.dependencies["@slack/web-api"]).toBe(
    hostPackageJson.devDependencies["@slack/web-api"],
  );
});
