import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

/**
 * The `iterate` dependency specifier the template ships with — pkg.pr.new's
 * branch ref for the latest build published from main
 * (.github/workflows/pkg-pr-new.yml publishes on every push).
 */
export const TEMPLATE_ITERATE_PACKAGE_SPEC = "https://pkg.pr.new/iterate/iterate@main";
export const TEMPLATE_TASKS_PACKAGE_SPEC =
  "https://pkg.pr.new/iterate/iterate/@iterate-com/tasks@main";

/**
 * The template file map to seed a project repo with, with the `iterate`
 * dependency optionally re-pointed via config (`iterateSdkPackageSpec`).
 * Preview deploys pass their PR's pkg.pr.new build so projects created there
 * — e2e tests included — install the branch tip's `iterate/sdk`, not
 * whatever main last published. Deliberately a find/replace on the manifest
 * that carries the spec (the repo root's runtime dependency):
 * the generated file map stays canonical, and the swap happens exactly where
 * files become a repo. Dynamic builds repeat the substitution so existing
 * repos also compile against the deployment's exact package.
 */
export function projectRepoSeedFiles(packageSpecs: {
  iterate: string | undefined;
  tasks: string | undefined;
}): Array<{ content: string; path: string }> {
  if (!packageSpecs.iterate && !packageSpecs.tasks) return PROJECT_REPO_INITIAL_FILES;
  let files = PROJECT_REPO_INITIAL_FILES;
  for (const substitution of [
    { replacement: packageSpecs.iterate, template: TEMPLATE_ITERATE_PACKAGE_SPEC },
    { replacement: packageSpecs.tasks, template: TEMPLATE_TASKS_PACKAGE_SPEC },
  ]) {
    if (!substitution.replacement) continue;
    let substituted = 0;
    files = files.map((file) => {
      if (!file.path.endsWith("package.json")) return file;
      if (!file.content.includes(`"${substitution.template}"`)) return file;
      substituted += 1;
      return {
        ...file,
        content: file.content.replaceAll(
          `"${substitution.template}"`,
          JSON.stringify(substitution.replacement),
        ),
      };
    });
    if (substituted === 0) {
      // Fail loudly: a silently un-substituted spec would make every preview
      // e2e project quietly test against main's build again.
      throw new Error(
        `No template package.json contains "${substitution.template}" — update its constant in project-repo-seed.ts to match.`,
      );
    }
  }
  return files;
}
