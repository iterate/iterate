import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withStreamProcessorRunner } from "@iterate-com/shared/durable-object-utils/mixins/with-stream-processor-runner";
import type { Callable } from "@iterate-com/shared/callable/types.ts";
import type { ProcessorStreamApi, StreamEvent } from "@iterate-com/shared/stream-processors";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import {
  type Event,
  type EventInput,
  STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
  type StreamCursor,
  type StreamPath,
} from "@iterate-com/shared/streams/types";
import {
  REPO_DEFAULT_BRANCH,
  REPO_README_PATH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  type CloudflareArtifactsBinding,
  createArtifactToken,
  pushInitialReadme,
  repoArtifactName,
} from "~/domains/repos/artifacts.ts";
import {
  createRepoStreamProcessor,
  RepoStreamProcessorContract,
  repoStreamPath,
} from "~/domains/repos/stream-processors/repo-stream-processor.ts";

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
};

export type CreateRepoInput = {
  projectSlug?: string;
};

const RepoStructuredName = z.object({
  projectId: z.string().trim().min(1),
  repoSlug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Repo slug must be lowercase kebab-case"),
});

type RepoEnv = {
  ARTIFACTS?: CloudflareArtifactsBinding;
  DO_CATALOG: D1Database;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
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

const RepoBase = withStreamProcessorRunner<
  RepoStructuredName,
  RepoEnv,
  typeof RepoStreamProcessorContract
>({
  processor() {
    return createRepoStreamProcessor();
  },
  streamApi(args) {
    return repoStreamApiFromNamespace({
      durableObjectNamespace: args.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: args.structuredName.projectId,
      streamPath: repoStreamPath(args.structuredName.repoSlug),
    });
  },
})(RepoLifecycleBase);

export class RepoDurableObject extends RepoBase<RepoEnv> {
  constructor(ctx: DurableObjectState, env: RepoEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureRepoSubscription(params);
      await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
    });
  }

  async createRepo(input: CreateRepoInput = {}): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });

    if (this.currentRepo() !== null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} already exists.`);
    }

    const artifactName = repoArtifactName(this.structuredName);
    const artifacts = this.requireArtifacts();
    const artifact = await artifacts.create(artifactName, {
      setDefaultBranch: REPO_DEFAULT_BRANCH,
    });
    const token = await createArtifactToken({
      artifact,
      artifacts,
      name: artifactName,
      scope: "write",
      ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
    });
    const defaultBranch = artifact.defaultBranch ?? artifact.default_branch ?? REPO_DEFAULT_BRANCH;

    await pushInitialReadme({
      defaultBranch,
      projectId: this.structuredName.projectId,
      projectSlug: input.projectSlug,
      remote: artifact.remote,
      repoSlug: this.structuredName.repoSlug,
      token: token.plaintext,
    });

    const event = await this.appendRepoCreatedEvent({
      defaultBranch,
      remote: artifact.remote,
      slug: this.structuredName.repoSlug,
      token: token.plaintext,
      tokenExpiresAt: token.expiresAt,
    });
    await this.consumeStreamProcessorEvent({ event: event as StreamEvent });

    return this.requireInfo();
  }

  async getInfo(): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.catchUpStreamProcessor({ signal: AbortSignal.timeout(30_000) });
    return this.requireInfo();
  }

  async afterAppend(input: { event: Event }) {
    await this.ensureStarted();
    return await this.consumeStreamProcessorEvent({ event: input.event as StreamEvent });
  }

  private currentRepo() {
    return this.getStreamProcessorRunnerState().state.repo;
  }

  private requireInfo(): RepoInfo {
    const repo = this.currentRepo();
    if (repo === null) {
      throw new Error(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    return {
      defaultBranch: repo.defaultBranch,
      git: gitInfo({
        defaultBranch: repo.defaultBranch,
        remote: repo.remote,
        slug: repo.slug,
        token: repo.token,
      }),
      readmePath: REPO_README_PATH,
      remote: repo.remote,
      slug: repo.slug,
      token: repo.token,
      tokenExpiresAt: repo.tokenExpiresAt,
    };
  }

  private requireArtifacts() {
    if (!this.env.ARTIFACTS) {
      throw new Error("ARTIFACTS binding is not configured.");
    }

    return this.env.ARTIFACTS;
  }

  private async appendRepoCreatedEvent(input: {
    defaultBranch: string;
    remote: string;
    slug: string;
    token: string;
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
      idempotencyKey: `repo-subscription:${params.projectId}:${params.repoSlug}`,
      payload: {
        slug: `repo:${params.repoSlug}`,
        type: "callable",
        callable: this.createSelfCallable("afterAppend"),
      },
    });
  }

  private createSelfCallable(rpcMethod: string): Callable {
    return {
      type: "workers-rpc",
      via: {
        type: "env-binding",
        bindingType: "durable-object-namespace",
        bindingName: "REPO",
        durableObject: {
          name: this.name,
        },
      },
      rpcMethod,
      argsMode: "object",
    };
  }
}

export function getRepoDurableObjectName(name: RepoStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: name,
  });
}

function gitInfo(input: { defaultBranch: string; remote: string; slug: string; token: string }) {
  const authorizationHeader = `Authorization: Bearer ${input.token}`;
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

type RepoStreamApi = ProcessorStreamApi<typeof RepoStreamProcessorContract> & {
  append(args: { event: EventInput; streamPath?: string }): Promise<Event>;
  read(args?: {
    streamPath?: string;
    afterOffset?: StreamCursor;
    beforeOffset?: StreamCursor;
  }): Promise<Event[]>;
};

function repoStreamApiFromNamespace(args: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  streamPath: StreamPath;
}): RepoStreamApi {
  return {
    async append(input) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveRepoProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.append(input.event);
    },
    async read(input = {}) {
      const stream = await getInitializedStreamStub({
        durableObjectNamespace: args.durableObjectNamespace,
        namespace: args.namespace,
        path: resolveRepoProcessorStreamPath({
          basePath: args.streamPath,
          pathInput: input.streamPath,
        }),
      });
      return await stream.history({
        after: input.afterOffset,
        before: input.beforeOffset ?? "end",
      });
    },
    async *subscribe(input = {}) {
      void input;
      yield* [];
      throw new Error("Repo processors receive live events through afterAppend RPC.");
    },
  };
}

function resolveRepoProcessorStreamPath(input: {
  basePath: StreamPath;
  pathInput?: string;
}): StreamPath {
  if (input.pathInput == null || input.pathInput.trim() === "") {
    return input.basePath;
  }

  return input.pathInput.startsWith("/")
    ? (input.pathInput as StreamPath)
    : (`${input.basePath}/${input.pathInput}` as StreamPath);
}
