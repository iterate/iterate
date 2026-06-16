import { DurableObject } from "cloudflare:workers";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "~/domains/streams/engine/shared/callable-subscriber.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import {
  REPO_DEFAULT_BRANCH,
  REPO_WRITE_TOKEN_TTL_SECONDS,
  type CloudflareArtifactsBinding,
  artifactRemoteUrl,
  createCloudflareArtifactsRestBinding,
  createArtifactToken,
  repoArtifactName,
  stripArtifactTokenQuery,
} from "~/domains/repos/artifacts.ts";
import { parseConfig } from "~/config.ts";
import { parseDurableObjectName } from "~/domains/durable-object-names.ts";
import { RepoNotCreatedError } from "~/domains/repos/repo-errors.ts";
import {
  CommitRepoFilesInput,
  ListRepoFilesInput,
  ReadRepoFilesInput,
  ReadRepoLogInput,
  ReadRepoTreeInput,
  commitRepoFiles,
  listRepoFiles,
  readRemoteBranchOid,
  readRepoFiles,
  readRepoLog,
  readRepoTree,
  type CommitRepoFilesResult,
} from "~/domains/repos/repo-git.ts";
import {
  RepoStreamProcessor,
  RepoStreamProcessorContract,
  type RepoCreateRequestedPayload,
  type RepoCreatedPayload,
  repoStreamPath,
} from "~/domains/repos/stream-processors/repo-stream-processor.ts";
import {
  getRepoDurableObjectName,
  type RepoDurableObjectName,
} from "~/domains/repos/repo-durable-object-name.ts";

export { getRepoDurableObjectName, type RepoDurableObjectName };

export type RepoInfo = {
  defaultBranch: string;
  git: {
    authorizationHeader: string;
    cloneCommand: string;
    commitExampleCommand: string;
    pushCommand: string;
    remote: string;
  };
  path: string;
  remote: string;
  token: string;
  tokenExpiresAt: string | null;
  credentials: { username: string; password: string };
};

export type CreateRepoInput = {
  source?:
    | { kind: "empty" }
    | {
        artifactName: string;
        defaultBranchOnly?: boolean;
        description?: string;
        kind: "artifact-fork";
      };
};

type RepoEnv = {
  APP_CONFIG?: string;
  ARTIFACTS?: CloudflareArtifactsBinding;
  ARTIFACTS_ACCOUNT_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

export class RepoDurableObject extends DurableObject<RepoEnv> {
  readonly name = parseDurableObjectName(this.ctx.id.name!);

  host = createStreamProcessorHost(this.ctx);
  repo = this.host.add(
    RepoStreamProcessorContract.slug,
    (deps) =>
      new RepoStreamProcessor({
        ...deps,
        createRepoArtifact: (input) => this.createRepoArtifact(input),
      }),
  );

  /** Subscription callables on the repo stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  private async ensureRepoStreamSetup(): Promise<void> {
    await this.ensureRepoSubscription();
  }

  private repoName(): RepoDurableObjectName {
    if (this.name.projectId === null) {
      throw new Error("Repo Durable Object must be project-scoped.");
    }
    if (!String(this.name.path).startsWith("/repos/")) {
      throw new Error(`Repo Durable Object path must start with "/repos/", got ${this.name.path}.`);
    }
    return { path: this.name.path, projectId: this.name.projectId };
  }

  async createRepo(input: CreateRepoInput = {}): Promise<RepoInfo> {
    await this.ensureRepoStreamSetup();
    const request = await this.appendRepoCreateRequestedEvent({
      path: String(this.repoName().path),
      source: input.source ?? { kind: "empty" },
    });
    await this.waitForRepoCreated(request.offset);

    return await this.requireInfo();
  }

  async getInfo(): Promise<RepoInfo> {
    await this.ensureRepoStreamSetup();
    await this.waitForRepoProcessorCatchUp();
    return await this.requireInfo();
  }

  async refreshWriteToken(): Promise<RepoInfo> {
    await this.ensureRepoStreamSetup();
    await this.waitForRepoProcessorCatchUp();
    return await this.requireInfo();
  }

  /**
   * Commit an array of file writes/deletes to a branch (the default branch
   * unless specified) and push — no workspace involved. The clone lives in a
   * throwaway in-memory filesystem for the duration of the call.
   */
  async commitFiles(input: CommitRepoFilesInput): Promise<CommitRepoFilesResult> {
    const parsed = CommitRepoFilesInput.parse(input);
    return await this.withRepoGitCredentials((info) =>
      commitRepoFiles({
        author: parsed.author,
        branch: parsed.branch ?? info.defaultBranch,
        changes: parsed.changes,
        defaultBranch: info.defaultBranch,
        message: parsed.message,
        remote: info.remote,
        token: info.token,
      }),
    );
  }

  /** Read files from a branch. Missing paths come back with `content: null`. */
  async readFiles(input: ReadRepoFilesInput) {
    const parsed = ReadRepoFilesInput.parse(input);
    return await this.withRepoGitCredentials(async (info) => {
      const branch = parsed.branch ?? info.defaultBranch;
      return {
        branch,
        files: await readRepoFiles({
          branch,
          encoding: parsed.encoding,
          paths: parsed.paths,
          remote: info.remote,
          token: info.token,
        }),
      };
    });
  }

  /** List all file paths on a branch. */
  async listFiles(input: ListRepoFilesInput = {}) {
    const parsed = ListRepoFilesInput.parse(input);
    return await this.withRepoGitCredentials(async (info) => {
      const branch = parsed.branch ?? info.defaultBranch;
      return {
        branch,
        paths: await listRepoFiles({ branch, remote: info.remote, token: info.token }),
      };
    });
  }

  /**
   * One checkout, one answer: the ref's head commit plus every file on it —
   * the build input for repo-sourced workers (itx/source-build.ts).
   */
  async readTree(input: ReadRepoTreeInput = {}) {
    const parsed = ReadRepoTreeInput.parse(input);
    return await this.withRepoGitCredentials((info) =>
      readRepoTree({
        branch: parsed.ref ?? info.defaultBranch,
        remote: info.remote,
        token: info.token,
      }),
    );
  }

  /** The ref's head commit oid — one HTTP request (ls-remote), no clone.
   * The cheap freshness probe for "latest" repo sources. */
  async headOid(input: { ref?: string } = {}) {
    return await this.withRepoGitCredentials(async (info) => ({
      oid: await readRemoteBranchOid({
        branch: input.ref ?? info.defaultBranch,
        remote: info.remote,
        token: info.token,
      }),
    }));
  }

  /** Read the commit log of a branch (newest first). */
  async readLog(input: ReadRepoLogInput = {}) {
    const parsed = ReadRepoLogInput.parse(input);
    return await this.withRepoGitCredentials(async (info) => {
      const branch = parsed.branch ?? info.defaultBranch;
      return {
        branch,
        commits: await readRepoLog({
          branch,
          depth: parsed.depth,
          remote: info.remote,
          token: info.token,
        }),
      };
    });
  }

  /** Runs a git operation with a fresh, on-demand artifact token. */
  private async withRepoGitCredentials<T>(operation: (info: RepoInfo) => Promise<T>): Promise<T> {
    await this.ensureRepoStreamSetup();
    await this.waitForRepoProcessorCatchUp();
    return await operation(await this.requireInfo());
  }

  async getArtifact() {
    await this.ensureRepoStreamSetup();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) === null) {
      throw new RepoNotCreatedError(`Repo ${this.repoName().path} has not been created.`);
    }

    return this.requireArtifacts().get(repoArtifactName(this.repoName()));
  }

  private async currentRepo() {
    return (await this.getRepoRunnerState()).state?.repo ?? null;
  }

  /** Legacy runner runtimeState shape over the hosted processor's checkpoint. */
  private async getRepoRunnerState(): Promise<RepoProcessorRuntimeState> {
    const snapshot = await this.repo.snapshot();
    return {
      state: snapshot.state,
      reducedThroughOffset: snapshot.offset,
    };
  }

  private async waitForRepoProcessorCatchUp(targetOffset?: number) {
    const maxOffset = targetOffset ?? (await this.currentConsumedEventMaxOffset());
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = await this.getRepoRunnerState();
      if (state.reducedThroughOffset >= maxOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async waitForRepoCreated(requestOffset: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await this.waitForRepoProcessorCatchUp(requestOffset);
      if ((await this.currentRepo()) !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new RepoNotCreatedError(`Repo ${this.repoName().path} was not created.`);
  }

  /**
   * Subscription delivery is filtered by the processor's `contract.consumes`,
   * so the checkpoint only ever advances to the latest consumed event — not to
   * the stream head. Waiting on the full max offset would always time out once
   * a non-consumed event (e.g. subscription-configured) tops the stream.
   */
  private async currentConsumedEventMaxOffset() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: this.repoName().projectId,
      path: repoStreamPath(this.repoName().path),
    });
    const consumed = new Set<string>(this.repo.contract.consumes);
    const events = await stream.history({ before: "end" });
    return events.filter((event) => consumed.has(event.type)).at(-1)?.offset ?? 0;
  }

  private async requireInfo(): Promise<RepoInfo> {
    const repo = await this.currentRepo();
    if (repo === null) {
      throw new RepoNotCreatedError(`Repo ${this.repoName().path} has not been created.`);
    }

    const artifactName = repoArtifactName(this.repoName());
    const artifacts = this.requireArtifacts();
    const token = await createArtifactToken({
      artifact: await artifacts.get(artifactName),
      artifacts,
      name: artifactName,
      scope: "write",
      ttlSeconds: REPO_WRITE_TOKEN_TTL_SECONDS,
    });

    return {
      defaultBranch: repo.defaultBranch,
      git: gitInfo({
        defaultBranch: repo.defaultBranch,
        path: repo.path,
        remote: repo.remote,
        token: token.plaintext,
      }),
      path: repo.path,
      remote: repo.remote,
      token: token.plaintext,
      tokenExpiresAt: token.expiresAt,
      credentials: { username: "x", password: stripArtifactTokenQuery(token.plaintext) },
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
    return parseConfig(this.env);
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

  private async createRepoArtifact(input: RepoCreateRequestedPayload): Promise<RepoCreatedPayload> {
    const artifactName = repoArtifactName(this.repoName());
    const artifacts = this.requireArtifacts();
    const source = input.source ?? { kind: "empty" as const };
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
    const remote = (await readArtifactString(artifact.remote)) ?? this.artifactRemote(artifactName);
    const defaultBranch =
      (await readArtifactString(artifact.defaultBranch)) ??
      (await readArtifactString(artifact.default_branch)) ??
      REPO_DEFAULT_BRANCH;

    return {
      defaultBranch,
      path: input.path,
      remote,
      tokenExpiresAt: null,
    };
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
        `Fork of ${input.source.artifactName} for ${this.repoName().path}`,
      readOnly: false,
    });
  }

  private async appendRepoCreateRequestedEvent(input: RepoCreateRequestedPayload) {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: this.repoName().projectId,
      path: repoStreamPath(this.repoName().path),
    });

    return await stream.append({
      type: "events.iterate.com/repo/create-requested",
      idempotencyKey: `repo-create-requested:${this.repoName().projectId}:${this.repoName().path}`,
      payload: input,
    });
  }

  private async ensureRepoSubscription() {
    const name = this.repoName();
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      projectId: name.projectId,
      path: repoStreamPath(name.path),
    });

    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `repo-subscription:${name.projectId}:${name.path}:workers-rpc:callable`,
      payload: {
        subscriptionKey: repoProcessorSubscriptionKey(name),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "REPO",
          durableObjectName: getRepoDurableObjectName(name),
          processorName: RepoStreamProcessorContract.slug,
        }),
      },
    });
  }
}

type RepoInfoSource = {
  defaultBranch: string;
  path: string;
  remote: string;
  tokenExpiresAt: string | null;
};

type RepoProcessorRuntimeState = {
  state: { repo: RepoInfoSource | null } | null;
  reducedThroughOffset: number;
};

/** Subscription coordinate used by the repo processor within a project stream. */
function repoProcessorSubscriptionKey(input: RepoDurableObjectName) {
  return `repo:${input.projectId}:${input.path}`;
}

function gitInfo(input: { defaultBranch: string; path: string; remote: string; token: string }) {
  const token = stripArtifactTokenQuery(input.token);
  const authorizationHeader = `Authorization: Bearer ${token}`;
  const quotedHeader = shellQuote(authorizationHeader);
  const quotedRemote = shellQuote(input.remote);
  const directory = input.path.split("/").filter(Boolean).at(-1) ?? "repo";
  const quotedDirectory = shellQuote(directory);

  return {
    authorizationHeader,
    cloneCommand: `git -c http.extraHeader=${quotedHeader} clone ${quotedRemote} ${quotedDirectory}`,
    commitExampleCommand: [
      `cd ${quotedDirectory}`,
      `printf ${shellQuote(`# ${input.path}\n`)} > README.md`,
      "git add README.md",
      `git commit -m ${shellQuote("Update README")}`,
    ].join("\n"),
    pushCommand: `git -c http.extraHeader=${quotedHeader} push origin ${shellQuote(
      input.defaultBranch,
    )}`,
    remote: input.remote,
  };
}

async function readArtifactString(value: unknown): Promise<string | undefined> {
  const candidate =
    typeof value === "function" ? (value as () => unknown | Promise<unknown>)() : value;
  const resolved = await candidate;
  return typeof resolved === "string" && resolved.length > 0 ? resolved : undefined;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
