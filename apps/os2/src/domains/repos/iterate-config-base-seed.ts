import { InMemoryFs } from "@cloudflare/shell";
import { createGit } from "@cloudflare/shell/git";
import {
  type CloudflareArtifactRepo,
  type CloudflareArtifactsBinding,
  artifactRemoteUrl,
  createArtifactToken,
  REPO_DEFAULT_BRANCH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  stripArtifactTokenQuery,
} from "~/domains/repos/artifacts.ts";
import { ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME } from "~/domains/repos/iterate-config-repo.ts";

const ITERATE_CONFIG_REPO_DIR = "/repo";
const ITERATE_CONFIG_JSONC = '{\n  "version": 1\n}\n';

export const ITERATE_CONFIG_WORKER_SOURCE = `// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Project extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
    return new Response("Hello from the project config worker at " + hostname, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-ingress-runtime": "dynamic-worker-config-repo",
      },
    });
  }

  async afterAppend({ event }) {
    console.log("Project config worker afterAppend", event.type);
  }
}
`;

export type SeedIterateConfigBaseResult = {
  committed: boolean;
  created: boolean;
  defaultBranch: string;
  remote: string;
};

export async function seedIterateConfigBaseRepo(input: {
  accountId: string;
  artifacts: CloudflareArtifactsBinding;
  namespace: string;
}): Promise<SeedIterateConfigBaseResult> {
  const { artifact, created } = await getOrCreateBaseArtifact(input.artifacts);
  const token = await createArtifactToken({
    artifact,
    artifacts: input.artifacts,
    name: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
    scope: "write",
    ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
  });
  const password = stripArtifactTokenQuery(token.plaintext);
  const filesystem = new InMemoryFs();
  const git = createGit(filesystem, "/");
  const remote =
    (await readArtifactString(artifact.remote)) ??
    artifactRemoteUrl({
      accountId: input.accountId,
      name: ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME,
      namespace: input.namespace,
    });
  const defaultBranch =
    (await readArtifactString(artifact.defaultBranch)) ??
    (await readArtifactString(artifact.default_branch)) ??
    REPO_DEFAULT_BRANCH;

  await filesystem.mkdir(ITERATE_CONFIG_REPO_DIR, { recursive: true });

  let cloned = false;
  try {
    await git.clone({
      url: remote,
      dir: ITERATE_CONFIG_REPO_DIR,
      branch: defaultBranch,
      depth: 1,
      username: "x",
      password,
    });
    cloned = true;
  } catch (error) {
    if (!created) throw error;
  }

  if (!cloned) {
    await git.init({ dir: ITERATE_CONFIG_REPO_DIR, defaultBranch });
    await git.remote({
      dir: ITERATE_CONFIG_REPO_DIR,
      add: {
        name: "origin",
        url: remote,
      },
    });
  }

  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/iterate.config.jsonc`,
    ITERATE_CONFIG_JSONC,
  );
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/worker.ts`, ITERATE_CONFIG_WORKER_SOURCE);
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "iterate.config.jsonc" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "worker.ts" });

  let committed = true;
  try {
    await git.commit({
      dir: ITERATE_CONFIG_REPO_DIR,
      message: "Seed iterate config worker",
      author: {
        name: "Iterate",
        email: "support@iterate.com",
      },
    });
  } catch (error) {
    if (!isNothingToCommitError(error)) throw error;
    committed = false;
  }

  if (committed || created) {
    await git.push({
      dir: ITERATE_CONFIG_REPO_DIR,
      remote: "origin",
      ref: defaultBranch,
      username: "x",
      password,
    });
  }

  return {
    committed,
    created,
    defaultBranch,
    remote,
  };
}

async function getOrCreateBaseArtifact(artifacts: CloudflareArtifactsBinding): Promise<{
  artifact: CloudflareArtifactRepo;
  created: boolean;
}> {
  try {
    return {
      artifact: await artifacts.create(ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME, {
        setDefaultBranch: REPO_DEFAULT_BRANCH,
      }),
      created: true,
    };
  } catch {
    return {
      artifact: await artifacts.get(ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME),
      created: false,
    };
  }
}

function isNothingToCommitError(error: unknown) {
  return error instanceof Error && /nothing to commit|no changes/i.test(error.message);
}

async function readArtifactString(value: unknown): Promise<string | null> {
  let candidate: unknown;
  try {
    candidate = typeof value === "function" ? (value as () => unknown | Promise<unknown>)() : value;
    const awaited = await candidate;
    return typeof awaited === "string" && awaited.length > 0 ? awaited : null;
  } catch {
    return null;
  }
}
