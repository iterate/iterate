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

export const ITERATE_CONFIG_WORKER_SOURCE = `import app1 from "./apps/app1/worker.js";
import app2 from "./apps/app2/worker.js";
import webhooks from "./apps/webhooks/worker.js";

const apps = [app1, app2, webhooks];

export default {
  async fetch(request, env) {
    for (const app of apps) {
      const response = await app.fetch(request, env);
      if (response) return response;
    }

    return new Response("Hello from the project worker");
  },

  // The worker is a stream processor: processEvent receives every event
  // committed to the project root stream ("/"), in order. React to facts by
  // appending facts — e.g. customize every new agent in this project by
  // watching for its stream to be created and appending your own context
  // events (the last system-prompt-updated wins; platform defaults yield to
  // yours):
  async processEvent({ event, streamPath }) {
    console.log("Project worker processEvent", streamPath, event.type);
  },

  // async processEvent({ event }, env) {
  //   if (event.type !== "events.iterate.com/stream/child-stream-created") return;
  //   const agentPath = event.payload.childPath;
  //   if (!agentPath.startsWith("/agents/")) return;
  //   await env.STREAMS.append({
  //     streamPath: agentPath,
  //     event: {
  //       type: "events.iterate.com/agent/system-prompt-updated",
  //       payload: { systemPrompt: "You are this project's agent. ..." },
  //     },
  //   });
  //   await env.STREAMS.append({
  //     streamPath: agentPath,
  //     event: {
  //       type: "events.iterate.com/agent/capability-noted",
  //       payload: { name: "worker.myTool", instructions: "Use itx.worker.myTool({ ... }) to ..." },
  //     },
  //   });
  // },
};
`;

const ITERATE_CONFIG_APP_ONE_WORKER_SOURCE = `export default {
  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "app1") return;
    return new Response("hello from app one");
  },
};
`;

const ITERATE_CONFIG_APP_TWO_WORKER_SOURCE = `export default {
  async fetch(request) {
    if (request.headers.get("x-iterate-app-slug") !== "app2") return;
    return new Response("hello from app two");
  },
};
`;

const ITERATE_CONFIG_WEBHOOKS_WORKER_SOURCE = `export default {
  async fetch(request, env) {
    if (request.headers.get("x-iterate-app-slug") !== "webhooks") return;
    const url = new URL(request.url);

    await env.STREAMS.append({
      streamPath: url.pathname === "/" ? "/webhooks" : \`/webhooks\${url.pathname}\`,
      event: {
        type: "unknown-webhook-received",
        payload: {
          url: url.toString(),
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body: await request.json(),
        },
      },
    });

    return Response.json({ ok: true });
  },
};
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
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/webhooks`, { recursive: true });
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/worker.js`, ITERATE_CONFIG_WORKER_SOURCE);
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app1/worker.js`,
    ITERATE_CONFIG_APP_ONE_WORKER_SOURCE,
  );
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app2/worker.js`,
    ITERATE_CONFIG_APP_TWO_WORKER_SOURCE,
  );
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/webhooks/worker.js`,
    ITERATE_CONFIG_WEBHOOKS_WORKER_SOURCE,
  );
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "iterate.config.jsonc" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "package.json" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "worker.js" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app1/worker.js" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app2/worker.js" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/webhooks/worker.js" });

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
