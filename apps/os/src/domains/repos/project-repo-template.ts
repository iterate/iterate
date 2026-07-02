import { PROJECT_REPO_INITIAL_FILES } from "./project-repo-template.generated.ts";

export { PROJECT_REPO_INITIAL_FILES };

/** Embedded in the onboarding agent's system prompt at project creation. */
export const PROJECT_REPO_ONBOARDING_MD = templateFile("ONBOARDING.md");

function templateFile(path: string): string {
  const file = PROJECT_REPO_INITIAL_FILES.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`project repo template has no ${path}`);
  return file.content;
}
