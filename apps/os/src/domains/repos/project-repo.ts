import { repoArtifactName } from "~/domains/repos/repo-artifact-name.ts";

export const PROJECT_REPO_PATH = "/repos/project";

export const ITERATE_CONFIG_BASE_REPO_REFERENCE = {
  path: "/repos/iterate-config-base",
  projectId: null,
} as const;

export const ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME = repoArtifactName(
  ITERATE_CONFIG_BASE_REPO_REFERENCE,
);
