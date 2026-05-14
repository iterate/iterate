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
const ITERATE_CONFIG_PACKAGE_JSON = '{\n  "type": "module"\n}\n';

export const ITERATE_CONFIG_WORKER_SOURCE = `// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export { AppOne } from "./apps/app1/worker.ts";
export { AppTwo } from "./apps/app2/worker.ts";

export default class Project extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = request.headers.get("x-iterate-ingress-hostname") ?? url.hostname;
    const appSlug = appSlugFromHostname(hostname);

    if (appSlug === "app1") {
      return await this.ctx.exports.AppOne.fetch(request);
    }

    if (appSlug === "app2") {
      return await this.ctx.exports.AppTwo.fetch(request);
    }

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

function appSlugFromHostname(hostname) {
  const firstLabel = hostname.split(".")[0] ?? "";
  if (firstLabel === "app1" || firstLabel.startsWith("app1__")) return "app1";
  if (firstLabel === "app2" || firstLabel.startsWith("app2__")) return "app2";
  return null;
}
`;

const ITERATE_CONFIG_APP_ONE_WORKER_SOURCE = `// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export class AppOne extends WorkerEntrypoint {
  async fetch() {
    return new Response("hello from app one", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-app": "app1",
      },
    });
  }
}
`;

const ITERATE_CONFIG_APP_TWO_WORKER_SOURCE = `// @ts-nocheck
import { WorkerEntrypoint } from "cloudflare:workers";

export class AppTwo extends WorkerEntrypoint {
  async fetch() {
    return new Response("hello from app two", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-project-app": "app2",
      },
    });
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
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/package.json`,
    ITERATE_CONFIG_PACKAGE_JSON,
  );
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/app1`, { recursive: true });
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/app2`, { recursive: true });
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/worker.ts`, ITERATE_CONFIG_WORKER_SOURCE);
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app1/worker.ts`,
    ITERATE_CONFIG_APP_ONE_WORKER_SOURCE,
  );
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app2/worker.ts`,
    ITERATE_CONFIG_APP_TWO_WORKER_SOURCE,
  );
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "iterate.config.jsonc" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "package.json" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "worker.ts" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app1/worker.ts" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app2/worker.ts" });

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
    await ensureBranchRef({ branch: defaultBranch, git });
  } catch (error) {
    if (!isNothingToCommitError(error)) throw error;
    committed = false;
  }

  if (committed) {
    await git.push({
      dir: ITERATE_CONFIG_REPO_DIR,
      force: true,
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

async function ensureBranchRef(input: { branch: string; git: ReturnType<typeof createGit> }) {
  try {
    await input.git.branch({
      dir: ITERATE_CONFIG_REPO_DIR,
      name: input.branch,
    });
  } catch (error) {
    if (!isBranchExistsError(error)) throw error;
  }
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

function isBranchExistsError(error: unknown) {
  return error instanceof Error && /already exists/i.test(error.message);
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
