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
import { ITERATE_CONFIG_BASE_REPO_ARTIFACT_NAME } from "~/domains/repos/project-repo.ts";
import {
  PROJECT_REPO_AGENTS_MD,
  PROJECT_REPO_ONBOARDING_MD,
} from "~/domains/repos/project-repo-template.ts";

const ITERATE_CONFIG_REPO_DIR = "/repo";
const ITERATE_CONFIG_JSONC = '{\n  "version": 1\n}\n';
const ITERATE_CONFIG_PACKAGE_JSON = `{
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260426.1",
    "iterate": "^0.2.6",
    "typescript": "^5.9.3"
  }
}
`;
const ITERATE_CONFIG_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["**/*.ts"]
}
`;

export const ITERATE_CONFIG_WORKER_SOURCE = `import {
  IterateProjectEntrypoint,
  type IterateProjectEventInput,
} from "iterate/worker";
import app1 from "./apps/app1/worker.ts";
import app2 from "./apps/app2/worker.ts";
import webhooks from "./apps/webhooks/worker.ts";

const apps = [app1, app2, webhooks];

export default class ProjectWorker extends IterateProjectEntrypoint {
  async fetch(request: Request) {
    for (const app of apps) {
      const response = await app.fetch(request, this.env);
      if (response) return response;
    }

    return new Response("Hello from the project worker");
  }

  // The project worker is a stream processor: onProjectEvent receives every
  // event committed to the project root stream ("/"), in order. React to
  // project facts here when you want customer-specific behavior.
  protected override async onProjectEvent({ event, streamPath }: IterateProjectEventInput) {
    console.log("Project worker event", streamPath, eventType(event));
  }
}

function eventType(event: unknown) {
  if (!event || typeof event !== "object" || !("type" in event)) return "unknown";
  return String(event.type);
}
`;

const ITERATE_CONFIG_APP_ONE_WORKER_SOURCE = `export default {
  async fetch(request: Request) {
    if (request.headers.get("x-iterate-app-slug") !== "app1") return;
    return new Response("hello from app one");
  },
};
`;

const ITERATE_CONFIG_APP_TWO_WORKER_SOURCE = `export default {
  async fetch(request: Request) {
    if (request.headers.get("x-iterate-app-slug") !== "app2") return;
    return new Response("hello from app two");
  },
};
`;

const ITERATE_CONFIG_WEBHOOKS_WORKER_SOURCE = `type ProjectWorkerEnv = {
  STREAMS: {
    append(input: { event: unknown; streamPath: string }): Promise<unknown>;
  };
};

export default {
  async fetch(request: Request, env: ProjectWorkerEnv) {
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
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/tsconfig.json`, ITERATE_CONFIG_TSCONFIG);
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/AGENTS.md`, PROJECT_REPO_AGENTS_MD);
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/ONBOARDING.md`,
    PROJECT_REPO_ONBOARDING_MD,
  );
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/app1`, { recursive: true });
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/app2`, { recursive: true });
  await filesystem.mkdir(`${ITERATE_CONFIG_REPO_DIR}/apps/webhooks`, { recursive: true });
  await filesystem.writeFile(`${ITERATE_CONFIG_REPO_DIR}/worker.ts`, ITERATE_CONFIG_WORKER_SOURCE);
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app1/worker.ts`,
    ITERATE_CONFIG_APP_ONE_WORKER_SOURCE,
  );
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/app2/worker.ts`,
    ITERATE_CONFIG_APP_TWO_WORKER_SOURCE,
  );
  await filesystem.writeFile(
    `${ITERATE_CONFIG_REPO_DIR}/apps/webhooks/worker.ts`,
    ITERATE_CONFIG_WEBHOOKS_WORKER_SOURCE,
  );
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "iterate.config.jsonc" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "package.json" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "tsconfig.json" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "AGENTS.md" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "ONBOARDING.md" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "worker.ts" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app1/worker.ts" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/app2/worker.ts" });
  await git.add({ dir: ITERATE_CONFIG_REPO_DIR, filepath: "apps/webhooks/worker.ts" });

  let committed = true;
  try {
    await git.commit({
      dir: ITERATE_CONFIG_REPO_DIR,
      message: "Seed project worker",
      author: {
        name: "Iterate",
        email: "support@iterate.com",
      },
    });
    await ensureBranchRef({ branch: defaultBranch, git });
  } catch (error) {
    if (!String(error).match(/nothing to commit|no changes/i)) {
      throw error;
    }
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
    if (!String(error).match(/already exists/i)) throw error;
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
