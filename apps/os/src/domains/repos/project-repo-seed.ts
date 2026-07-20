import { PROJECT_REPO_INITIAL_FILES } from "./config-repo-template.generated.ts";

/**
 * The `iterate` dependency specifier the template ships with — pkg.pr.new's
 * branch ref for the latest build published from main
 * (.github/workflows/pkg-pr-new.yml publishes on every push).
 */
export const TEMPLATE_ITERATE_PACKAGE_SPEC = "https://pkg.pr.new/iterate/iterate/iterate@main";

/**
 * The template file map to seed a project repo with, with the `iterate`
 * dependency optionally re-pointed via config (`iterateSdkPackageSpec`).
 * Preview deploys pass their PR's pkg.pr.new build so projects created there
 * — e2e tests included — install the branch tip's `iterate/sdk`, not
 * whatever main last published. Deliberately a find/replace on the manifests
 * that carry the spec (the repo root and seeded apps' devDependency for
 * typechecking/editor support — the platform injects runtime modules): the
 * generated file map stays canonical, and the swap happens exactly where
 * files become a repo.
 */
export function projectRepoSeedFiles(
  iterateSdkPackageSpec: string | undefined,
): Array<{ content: string; path: string }> {
  if (!iterateSdkPackageSpec) return PROJECT_REPO_INITIAL_FILES;
  let substituted = 0;
  const files = PROJECT_REPO_INITIAL_FILES.map((file) => {
    if (!file.path.endsWith("package.json")) return file;
    if (!file.content.includes(`"${TEMPLATE_ITERATE_PACKAGE_SPEC}"`)) return file;
    substituted += 1;
    return {
      ...file,
      content: file.content.replaceAll(
        `"${TEMPLATE_ITERATE_PACKAGE_SPEC}"`,
        JSON.stringify(iterateSdkPackageSpec),
      ),
    };
  });
  if (substituted === 0) {
    // Fail loudly: a silently un-substituted spec would make every preview
    // e2e project quietly test against main's build again.
    throw new Error(
      `No template package.json contains "${TEMPLATE_ITERATE_PACKAGE_SPEC}" — update TEMPLATE_ITERATE_PACKAGE_SPEC in project-repo-seed.ts to match.`,
    );
  }
  return files;
}
