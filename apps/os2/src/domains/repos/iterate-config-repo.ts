import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  REPO_DEFAULT_BRANCH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  type CloudflareArtifactRepo,
  type CloudflareArtifactsBinding,
  createArtifactToken,
} from "~/domains/repos/artifacts.ts";

export const ITERATE_CONFIG_REPO_SLUG = "iterate-config";
export const ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME = "iterate-config-base";

const ITERATE_CONFIG_BASE_CONTENT = `{
  // Placeholder for project-scoped Iterate configuration.
  "version": 1,
}
`;

export async function seedIterateConfigBaseArtifactRepo(input: {
  artifacts: CloudflareArtifactsBinding;
}) {
  const artifact = await getOrCreateIterateConfigBaseArtifact(input.artifacts);
  const token = await createArtifactToken({
    artifact,
    artifacts: input.artifacts,
    name: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
    scope: "write",
    ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
  });
  const remote = requireArtifactRemote(artifact);
  const defaultBranch = artifact.defaultBranch ?? artifact.default_branch ?? REPO_DEFAULT_BRANCH;
  const filesystem = new InMemoryFs({
    "/iterate.config.jsonc": ITERATE_CONFIG_BASE_CONTENT,
  });
  const git = createGit(filesystem, "/");

  await git.init({ defaultBranch });
  await git.add({ filepath: "iterate.config.jsonc" });
  await git.commit({
    message: "Seed iterate config",
    author: {
      name: "Iterate",
      email: "support@iterate.com",
    },
  });
  await git.remote({
    add: {
      name: "origin",
      url: remote,
    },
  });
  await git.push({
    force: true,
    password: token.plaintext,
    ref: defaultBranch,
    remote: "origin",
    username: "x",
  });

  return {
    defaultBranch,
    remote,
    repoName: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
  };
}

async function getOrCreateIterateConfigBaseArtifact(artifacts: CloudflareArtifactsBinding) {
  try {
    return await artifacts.create(ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME, {
      setDefaultBranch: REPO_DEFAULT_BRANCH,
    });
  } catch {
    return await artifacts.get(ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME);
  }
}

function requireArtifactRemote(artifact: CloudflareArtifactRepo) {
  if (!artifact.remote) {
    throw new Error("Cloudflare Artifacts repo handle did not include remote.");
  }
  return artifact.remote;
}
