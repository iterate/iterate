import { timedStep } from "../../lib/step-timing.ts";
import { getOrCreateArtifact, type GetOrCreateArtifactResult } from "./artifact-creation.ts";
import { artifactWriteToken, seedArtifactRepo } from "./artifact-seeding.ts";
import { readGithubTemplateFiles } from "./github-template-artifact.ts";
import {
  createGithubTemplateSource,
  type GithubTemplateFile,
  type ResolvedGithubTemplateSource,
} from "./github-template-source.ts";
import { REPO_DEFAULT_BRANCH } from "./repo-defaults.ts";

export type SeededHead = { commitOid: string; contentHash: string };

/**
 * Materialize one immutable public-GitHub template into a fresh Artifact.
 *
 * No Repo Durable Object state is required: the Artifact name and remote are
 * pure coordinates, source cleanup is awaited, and retries preserve an
 * already-pushed branch. That makes this safe for the independent creation
 * coordinator, outside the retained Repo/Stream callback actor tree.
 */
export async function createGithubTemplateArtifact(input: {
  artifactName: string;
  artifacts: Artifacts;
  artifactsAccountId: string;
  artifactsNamespace: string;
  onSeedHeadPrepared?: (head: SeededHead) => void;
  projectId: string | null;
  repoPath: string;
  source: ResolvedGithubTemplateSource;
}): Promise<{ artifactName: string; defaultBranch: string; remote: string }> {
  const timing = { path: input.repoPath, projectId: input.projectId };
  const remote = `https://${input.artifactsAccountId}.artifacts.cloudflare.net/git/${input.artifactsNamespace}/${input.artifactName}.git`;
  const existing = await timedStep("create-timing", timing, "artifact-get-or-create", () =>
    getOrCreateArtifact(input.artifacts, input.artifactName, {
      defaultBranch: REPO_DEFAULT_BRANCH,
    }),
  );
  const files = await timedStep("create-timing", timing, "template-read", () =>
    readGithubTemplateFiles({
      artifacts: input.artifacts,
      source: input.source,
      // Deliberately unauthenticated: public Git/REST/raw access is the proof
      // that this source is public. User credentials must never widen it.
      sourceAdapter: createGithubTemplateSource(),
      temporaryArtifactName: `${input.artifactName}--template-source`,
    }),
  );
  await seedKnownArtifact({
    artifact: existing,
    artifactName: input.artifactName,
    artifacts: input.artifacts,
    files,
    expectExisting: existing.lastPushAt !== null,
    onSeedHeadPrepared: input.onSeedHeadPrepared,
    remote,
    timing,
  });
  return { artifactName: input.artifactName, defaultBranch: REPO_DEFAULT_BRANCH, remote };
}

async function seedKnownArtifact(input: {
  artifact: GetOrCreateArtifactResult;
  artifactName: string;
  artifacts: Artifacts;
  expectExisting: boolean;
  files: GithubTemplateFile[];
  onSeedHeadPrepared?: (head: SeededHead) => void;
  remote: string;
  timing: { path: string; projectId: string | null };
}): Promise<SeededHead> {
  const token =
    input.artifact.initialWriteToken ??
    (await timedStep("create-timing", input.timing, "artifact-token", () =>
      artifactWriteToken(input.artifacts, input.artifactName),
    ));
  return await timedStep("create-timing", input.timing, "artifact-seed", () =>
    seedArtifactRepo({
      branch: REPO_DEFAULT_BRANCH,
      expectExisting: input.expectExisting,
      files: input.files.map((file) => ({
        content: file.bytes,
        mode: file.mode,
        path: file.path,
      })),
      onSeedHeadPrepared: input.onSeedHeadPrepared,
      remote: input.remote,
      token,
    }),
  );
}
