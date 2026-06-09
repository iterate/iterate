import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { type Event } from "@iterate-com/shared/streams/types";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";
import {
  REPO_DEFAULT_BRANCH,
  REPO_README_PATH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  type CloudflareArtifactRepo,
  type CloudflareArtifactsBinding,
  artifactRemoteUrl,
  createCloudflareArtifactsRestBinding,
  createArtifactToken,
  pushInitialReadme,
  repoArtifactName,
  stripArtifactTokenQuery,
} from "~/domains/repos/artifacts.ts";
import { parseConfig } from "~/config.ts";
import {
  RepoStreamProcessorContract,
  repoStreamPath,
} from "~/domains/repos/stream-processors/repo-stream-processor.ts";
import type { StreamProcessorRunner } from "~/domains/streams/durable-objects/stream-processor-runner.ts";

export type RepoStructuredName = {
  projectId: string;
  repoSlug: string;
};

export type RepoInfo = {
  defaultBranch: string;
  git: {
    authorizationHeader: string;
    cloneCommand: string;
    commitExampleCommand: string;
    pushCommand: string;
    remote: string;
  };
  readmePath: string;
  remote: string;
  slug: string;
  token: string;
  tokenExpiresAt: string | null;
  credentials: { username: string; password: string };
};

export type CreateRepoInput = {
  projectSlug?: string;
  source?:
    | { kind: "initial-readme" }
    | {
        artifactName: string;
        defaultBranchOnly?: boolean;
        description?: string;
        kind: "artifact-fork";
      };
};

const RepoStructuredName = z.object({
  projectId: z.string().trim().min(1),
  repoSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Repo slug must be lowercase kebab-case"),
});

type RepoEnv = {
  APP_CONFIG?: string;
  ARTIFACTS?: CloudflareArtifactsBinding;
  ARTIFACTS_ACCOUNT_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<StreamProcessorRunner>;
};

const RepoLifecycleBase = createIterateDurableObjectBase<
  typeof RepoStructuredName,
  Pick<RepoEnv, "DO_CATALOG">
>({
  className: "RepoDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
    repoSlug: (params) => params.repoSlug,
  },
  nameSchema: RepoStructuredName,
});

const REPO_WRITE_TOKEN_STORAGE_KEY = "repo.writeToken";
const REPO_WRITE_TOKEN_EXPIRES_AT_STORAGE_KEY = "repo.writeTokenExpiresAt";
const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class RepoDurableObject extends RepoLifecycleBase<RepoEnv> {
  constructor(ctx: DurableObjectState, env: RepoEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureRepoSubscription(params);
    });
  }

  async createRepo(input: CreateRepoInput = {}): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) !== null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} already exists.`);
    }

    const artifactName = repoArtifactName(this.structuredName);
    const artifacts = this.requireArtifacts();
    const source = input.source ?? { kind: "initial-readme" as const };
    const artifact =
      source.kind === "artifact-fork"
        ? await this.forkArtifactRepo({
            artifactName,
            artifacts,
            source,
          })
        : await artifacts.create(artifactName, {
            setDefaultBranch: REPO_DEFAULT_BRANCH,
          });
    const token = await createArtifactToken({
      artifact,
      artifacts,
      name: artifactName,
      scope: "write",
      ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
    });
    const remote = (await readArtifactString(artifact.remote)) ?? this.artifactRemote(artifactName);
    const defaultBranch =
      (await readArtifactString(artifact.defaultBranch)) ??
      (await readArtifactString(artifact.default_branch)) ??
      REPO_DEFAULT_BRANCH;

    if (source.kind === "initial-readme") {
      await pushInitialReadme({
        defaultBranch,
        projectId: this.structuredName.projectId,
        projectSlug: input.projectSlug,
        remote,
        repoSlug: this.structuredName.repoSlug,
        token: token.plaintext,
      });
    }

    await this.ctx.storage.put(REPO_WRITE_TOKEN_STORAGE_KEY, token.plaintext);
    const event = await this.appendRepoCreatedEvent({
      defaultBranch,
      remote,
      slug: this.structuredName.repoSlug,
      tokenExpiresAt: token.expiresAt,
    });
    await this.waitForRepoProcessorCatchUp(event.offset);

    return await this.requireInfo();
  }

  async getInfo(): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();
    return await this.requireInfo();
  }

  async refreshWriteToken(): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) === null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    const artifactName = repoArtifactName(this.structuredName);
    const artifacts = this.requireArtifacts();
    const token = await createArtifactToken({
      artifact: await artifacts.get(artifactName),
      artifacts,
      name: artifactName,
      scope: "write",
      ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
    });

    await this.ctx.storage.put(REPO_WRITE_TOKEN_STORAGE_KEY, token.plaintext);
    await this.ctx.storage.put(REPO_WRITE_TOKEN_EXPIRES_AT_STORAGE_KEY, token.expiresAt);

    return await this.requireInfo();
  }

  async getArtifact(): Promise<CloudflareArtifactRepo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) === null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    return this.requireArtifacts().get(repoArtifactName(this.structuredName));
  }

  async afterAppend(input: { event: Event }) {
    void input;
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();
    return await this.getRepoRunnerState();
  }

  private async currentRepo() {
    return (await this.getRepoRunnerState()).state?.repo ?? null;
  }

  private async getRepoRunnerState() {
    const runner = this.env.STREAM_PROCESSOR_RUNNER.getByName(
      repoProcessorRunnerName(this.structuredName),
    ) as unknown as { runtimeState(): Promise<RepoProcessorRuntimeState> };
    return await runner.runtimeState();
  }

  private async waitForRepoProcessorCatchUp(targetOffset?: number) {
    const maxOffset = targetOffset ?? (await this.currentStreamMaxOffset());
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await this.getRepoRunnerState();
      if (state.reducedThroughOffset >= maxOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async currentStreamMaxOffset() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: repoStreamPath(this.structuredName.repoSlug),
    });
    return (await stream.history({ before: "end" })).at(-1)?.offset ?? 0;
  }

  private async requireInfo(): Promise<RepoInfo> {
    const repo = await this.currentRepo();
    if (repo === null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    const token = await this.ctx.storage.get<string>(REPO_WRITE_TOKEN_STORAGE_KEY);
    if (!token) {
      throw new Error(`Repo ${this.structuredName.repoSlug} write token is not available.`);
    }

    const tokenExpiresAt =
      (await this.ctx.storage.get<string | null>(REPO_WRITE_TOKEN_EXPIRES_AT_STORAGE_KEY)) ??
      repo.tokenExpiresAt;

    return {
      defaultBranch: repo.defaultBranch,
      git: gitInfo({
        defaultBranch: repo.defaultBranch,
        remote: repo.remote,
        slug: repo.slug,
        token,
      }),
      readmePath: REPO_README_PATH,
      remote: repo.remote,
      slug: repo.slug,
      token,
      tokenExpiresAt,
      credentials: { username: "x", password: stripArtifactTokenQuery(token) },
    };
  }

  private requireArtifacts() {
    const apiToken = this.getAppConfig().cloudflare.apiToken?.exposeSecret();
    if (apiToken && this.env.ARTIFACTS_ACCOUNT_ID && this.env.ARTIFACTS_NAMESPACE) {
      return createCloudflareArtifactsRestBinding({
        accountId: this.env.ARTIFACTS_ACCOUNT_ID,
        apiToken,
        namespace: this.env.ARTIFACTS_NAMESPACE,
      });
    }

    if (!this.env.ARTIFACTS) {
      throw new Error("ARTIFACTS binding is not configured.");
    }

    return this.env.ARTIFACTS;
  }

  private getAppConfig() {
    return parseConfig(this.env as Record<string, unknown>);
  }

  private artifactRemote(artifactName: string) {
    if (!this.env.ARTIFACTS_ACCOUNT_ID || !this.env.ARTIFACTS_NAMESPACE) {
      throw new Error("Artifacts account and namespace bindings are required.");
    }

    return artifactRemoteUrl({
      accountId: this.env.ARTIFACTS_ACCOUNT_ID,
      name: artifactName,
      namespace: this.env.ARTIFACTS_NAMESPACE,
    });
  }

  private async forkArtifactRepo(input: {
    artifactName: string;
    artifacts: CloudflareArtifactsBinding;
    source: Extract<NonNullable<CreateRepoInput["source"]>, { kind: "artifact-fork" }>;
  }) {
    const sourceArtifact = await input.artifacts.get(input.source.artifactName);
    if (typeof sourceArtifact.fork !== "function") {
      throw new Error("Cloudflare Artifacts repo handle did not expose fork().");
    }

    return await sourceArtifact.fork(input.artifactName, {
      defaultBranchOnly: input.source.defaultBranchOnly ?? true,
      description:
        input.source.description ??
        `Fork of ${input.source.artifactName} for ${this.structuredName.repoSlug}`,
      readOnly: false,
    });
  }

  private async appendRepoCreatedEvent(input: {
    defaultBranch: string;
    remote: string;
    slug: string;
    tokenExpiresAt: string | null;
  }) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: repoStreamPath(this.structuredName.repoSlug),
    });

    return await stream.append({
      type: "events.iterate.com/repo/created",
      idempotencyKey: `repo-created:${this.structuredName.projectId}:${this.structuredName.repoSlug}`,
      payload: input,
    });
  }

  private async ensureRepoSubscription(params: RepoStructuredName) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: repoStreamPath(params.repoSlug),
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `repo-subscription:${params.projectId}:${params.repoSlug}:workers-rpc`,
      payload: {
        subscriptionKey: repoProcessorSubscriptionKey(params),
        subscriber: {
          type: "built-in",
          transport: "workers-rpc",
          processorSlug: RepoStreamProcessorContract.slug,
        },
      },
    });
  }
}

type RepoInfoSource = {
  defaultBranch: string;
  remote: string;
  slug: string;
  tokenExpiresAt: string | null;
};

type RepoProcessorRuntimeState = {
  state: { repo: RepoInfoSource | null } | null;
  reducedThroughOffset: number;
};

function repoProcessorSubscriptionKey(input: RepoStructuredName) {
  return `repo:${input.projectId}:${input.repoSlug}`;
}

function repoProcessorRunnerName(input: RepoStructuredName) {
  const streamPath = repoStreamPath(input.repoSlug);
  return `${input.projectId}:${streamPath}:${repoProcessorSubscriptionKey(input)}`;
}

export function getRepoDurableObjectName(name: RepoStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: name,
  });
}

function gitInfo(input: { defaultBranch: string; remote: string; slug: string; token: string }) {
  const token = stripArtifactTokenQuery(input.token);
  const authorizationHeader = `Authorization: Bearer ${token}`;
  const quotedHeader = shellQuote(authorizationHeader);
  const quotedRemote = shellQuote(input.remote);
  const quotedSlug = shellQuote(input.slug);

  return {
    authorizationHeader,
    cloneCommand: `git -c http.extraHeader=${quotedHeader} clone ${quotedRemote} ${quotedSlug}`,
    commitExampleCommand: [
      `cd ${shellQuote(input.slug)}`,
      `printf ${shellQuote(`# ${input.slug}\n`)} > ${shellQuote(REPO_README_PATH)}`,
      `git add ${shellQuote(REPO_README_PATH)}`,
      `git commit -m ${shellQuote("Update README")}`,
    ].join("\n"),
    pushCommand: `git -c http.extraHeader=${quotedHeader} push origin ${shellQuote(
      input.defaultBranch,
    )}`,
    remote: input.remote,
  };
}

async function readArtifactString(value: unknown): Promise<string | undefined> {
  let candidate: unknown;
  try {
    candidate = typeof value === "function" ? (value as () => unknown | Promise<unknown>)() : value;
    const resolved = await candidate;
    return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
