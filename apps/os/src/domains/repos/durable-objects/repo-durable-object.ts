import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
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
import { RepoNotCreatedError } from "~/domains/repos/repo-errors.ts";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import { getSecretStub } from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import {
  CommitRepoFilesInput,
  ListRepoFilesInput,
  ReadRepoFilesInput,
  ReadRepoLogInput,
  ReadRepoTreeInput,
  commitRepoFiles,
  isGitAuthError,
  listRepoFiles,
  readRemoteBranchOid,
  readRepoFiles,
  readRepoLog,
  readRepoTree,
  type CommitRepoFilesResult,
  type RepoFileChange,
} from "~/domains/repos/repo-git.ts";
import {
  RepoRemote,
  RepoStreamProcessor,
  RepoStreamProcessorContract,
  repoRemoteKey,
  repoStreamPath,
} from "~/domains/repos/stream-processors/repo-stream-processor.ts";
import {
  getRepoDurableObjectName,
  type RepoStructuredName,
} from "~/domains/repos/repo-durable-object-name.ts";

export { getRepoDurableObjectName, type RepoStructuredName };

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
  host = createStreamProcessorHost(this.ctx);
  repo = this.host.add(RepoStreamProcessorContract.slug, (deps) => {
    return new RepoStreamProcessor({
      ...deps,
      // The mirror PULL: fetch each changed file from GitHub at headSha and
      // commit the batch to the artifact. Auth is a placeholder token
      // chain-fetched through the Secret DO — this host never holds the
      // credential. Incremental by webhook content; large pushes fail loudly
      // (a full git mirror via workspace-git is the upgrade path).
      pullFromGithub: async ({ remote, headSha, changedPaths }) => {
        if (changedPaths.length > 200) {
          throw new Error(
            `push touches ${changedPaths.length} files; incremental mirror caps at 200`,
          );
        }
        const { projectId } = this.structuredName;
        const tokenSlug = providedSecretSlug({
          integration: "github",
          account: remote.account,
          name: "access-token",
        });
        // The established placeholder-SDK convention: octokit holds the
        // getSecret placeholder as its token and fetches through the Secret
        // DO chain, which substitutes (and inline-refreshes) on the way out.
        const octokit = new Octokit({
          auth: `getSecret({ key: "${tokenSlug}" })`,
          request: {
            fetch: (async (url: RequestInfo | URL, init?: RequestInit) =>
              await getSecretStub({ projectId, slug: tokenSlug }).egressFetch({
                request: new Request(url, init),
                keys: [tokenSlug],
              })) as typeof fetch,
          },
        });
        const changes: RepoFileChange[] = [];
        for (const { path, change } of changedPaths) {
          if (change === "delete") {
            changes.push({ path, delete: true });
            continue;
          }
          const { data } = await octokit.rest.repos.getContent({
            owner: remote.owner,
            repo: remote.repo,
            path,
            ref: headSha,
          });
          if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") {
            throw new Error(`GitHub contents ${path}@${headSha}: not a base64 file`);
          }
          changes.push({ path, content: data.content.replaceAll("\n", ""), encoding: "base64" });
        }
        if (changes.length === 0) return { commitOid: null };
        const result = await this.commitFiles({
          message: `Mirror ${remote.owner}/${remote.repo}@${headSha.slice(0, 7)}`,
          changes,
        });
        return { commitOid: result.noChanges ? null : result.commitOid };
      },
    });
  });

  constructor(ctx: DurableObjectState, env: RepoEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureRepoSubscription(params);
    });
  }

  /** Subscription callables on the repo stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
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

  /**
   * Configure a GitHub repository as a remote of this repo: ONE journaled
   * fact (`repo/remote-configured`); the processor reacts by registering the
   * webhook route on the github account stream. Re-configuring the same
   * remote is last-write-wins.
   */
  async configureRemote(input: RepoRemote): Promise<{ remoteKey: string; remote: RepoRemote }> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();
    if ((await this.currentRepo()) === null) {
      throw new RepoNotCreatedError(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    const remote = RepoRemote.parse(input);
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: repoStreamPath(this.structuredName.repoSlug),
    });
    const event = await stream.append({
      type: "events.iterate.com/repo/remote-configured",
      idempotencyKey: `repo-remote-configured:${repoRemoteKey(remote)}:${await sha256Hex(
        JSON.stringify(remote),
      )}`,
      payload: remote,
    });
    await this.waitForRepoProcessorCatchUp(event.offset);
    return { remoteKey: repoRemoteKey(remote), remote };
  }

  /** The fold's remote-sync view: configured remotes + last mirror outcome. */
  async getSyncState(): Promise<{
    remotes: Record<string, RepoRemote>;
    lastSync?: { headSha: string; at: string; status: "synced" | "failed"; reason?: string };
  }> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();
    const snapshot = await this.repo.snapshot();
    return {
      remotes: snapshot.state?.remotes ?? {},
      ...(snapshot.state?.lastSync == null ? {} : { lastSync: snapshot.state.lastSync }),
    };
  }

  async refreshWriteToken(): Promise<RepoInfo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) === null) {
      throw new RepoNotCreatedError(`Repo ${this.structuredName.repoSlug} has not been created.`);
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

  /** Runs a git operation with the stored write token, refreshing it once on auth failure. */
  private async withRepoGitCredentials<T>(operation: (info: RepoInfo) => Promise<T>): Promise<T> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();
    const info = await this.requireInfo();
    try {
      return await operation(info);
    } catch (error) {
      if (!isGitAuthError(error)) throw error;
      return await operation(await this.refreshWriteToken());
    }
  }

  async getArtifact(): Promise<CloudflareArtifactRepo> {
    await this.ensureStarted();
    await this.waitForRepoProcessorCatchUp();

    if ((await this.currentRepo()) === null) {
      throw new RepoNotCreatedError(`Repo ${this.structuredName.repoSlug} has not been created.`);
    }

    return this.requireArtifacts().get(repoArtifactName(this.structuredName));
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

  /**
   * Subscription delivery is filtered by the processor's `contract.consumes`,
   * so the checkpoint only ever advances to the latest consumed event — not to
   * the stream head. Waiting on the full max offset would always time out once
   * a non-consumed event (e.g. subscription-configured) tops the stream.
   */
  private async currentConsumedEventMaxOffset() {
    const stream = await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: this.structuredName.projectId,
      path: repoStreamPath(this.structuredName.repoSlug),
    });
    const consumed = new Set<string>(this.repo.contract.consumes);
    const events = await stream.history({ before: "end" });
    return events.filter((event) => consumed.has(event.type)).at(-1)?.offset ?? 0;
  }

  private async requireInfo(): Promise<RepoInfo> {
    const repo = await this.currentRepo();
    if (repo === null) {
      throw new RepoNotCreatedError(`Repo ${this.structuredName.repoSlug} has not been created.`);
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

    // ":callable" suffix: the subscriber switched from the legacy built-in
    // runner to a Callable subscription. Changing the idempotency key lets the
    // new subscription-configured event land on existing streams that already
    // recorded the old one.
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `repo-subscription:${params.projectId}:${params.repoSlug}:workers-rpc:callable`,
      payload: {
        subscriptionKey: repoProcessorSubscriptionKey(params),
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "REPO",
          durableObjectName: getRepoDurableObjectName(params),
          processorName: RepoStreamProcessorContract.slug,
        }),
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
