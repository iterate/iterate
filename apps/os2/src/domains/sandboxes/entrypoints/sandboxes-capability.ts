import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import {
  getSandbox,
  type ExecOptions,
  type ExecResult,
  type Sandbox as CloudflareSandbox,
} from "@cloudflare/sandbox";
import {
  getInitializedDoStub,
  listD1ObjectCatalogRecordsByIndex,
  type D1ObjectCatalogRecord,
} from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { getReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
import type { RepoInfo } from "~/domains/repos/durable-objects/repo-durable-object.ts";
import {
  SANDBOX_WORKSPACE_MOUNT_PATH,
  SANDBOX_ITERATE_CONFIG_PATH,
  type SandboxInfo,
  type SandboxDurableObject,
  type SandboxStructuredName,
  sandboxInfo,
  sandboxRuntimeId,
} from "~/domains/sandboxes/durable-objects/sandbox-durable-object.ts";

type SandboxesCapabilityEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string;
  DO_CATALOG?: D1Database;
  PROJECT_SANDBOX?: DurableObjectNamespace<SandboxDurableObject>;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  SANDBOX_RUNTIME?: DurableObjectNamespace<CloudflareSandbox>;
  SANDBOX_STORAGE_BUCKET_NAME?: string;
  SANDBOX_STORAGE_ENDPOINT?: string;
  SANDBOX_STORAGE_LOCAL_DEV?: string;
};

export type SandboxesCapabilityProps = {
  projectId: string;
};

export type SandboxCatalogRecord = {
  createdAt: string;
  lastWokenAt: string;
  name: string;
  projectId: string;
  slug: string;
};

export type SandboxExecInput = {
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
};

type SandboxesCapabilityClient = Pick<
  SandboxesCapability,
  | "create"
  | "createInfo"
  | "destroyRuntime"
  | "exec"
  | "get"
  | "getInfo"
  | "getInitialized"
  | "list"
  | "wake"
>;
type SandboxLifecycleCatalogRecord = D1ObjectCatalogRecord<SandboxStructuredName>;
const ARTIFACT_FS_ROOT = "/workspace/.artifact-fs";
const ITERATE_CONFIG_REPO_NAME = "iterate-config";

export class SandboxHandle extends RpcTarget {
  readonly #sandbox: DurableObjectStub<SandboxDurableObject>;

  constructor(sandbox: DurableObjectStub<SandboxDurableObject>) {
    super();
    this.#sandbox = sandbox;
  }

  async getInfo(): Promise<SandboxInfo> {
    return await this.#sandbox.getInfo();
  }
}

export class SandboxesCapability extends WorkerEntrypoint<
  SandboxesCapabilityEnv,
  SandboxesCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const projectId = readProjectId(input);
    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};

    switch (input.functionPath.join(".")) {
      case "create":
        return await this.create({ projectId, slug: readSlug(options.slug) });
      case "get":
        return await this.get({ projectId, slug: readSlug(options.slug) });
      case "getInitialized":
        return await this.getInitialized({ projectId, slug: readSlug(options.slug) });
      case "list":
        return await this.list({ projectId });
      case "wake":
        return await this.wake({ projectId, slug: readSlug(options.slug) });
      default:
        throw new Error(`SandboxesCapability does not implement ${input.functionPath.join(".")}`);
    }
  }

  async create(input: { projectId?: string; slug: string }) {
    return new SandboxHandle(await this.initializedLogicalSandbox(input.slug, input.projectId));
  }

  async createInfo(input: { slug: string }): Promise<SandboxInfo> {
    return await (await this.create(input)).getInfo();
  }

  async get(input: { projectId?: string; slug: string }) {
    const sandbox = await getInitializedDoStub({
      allowCreate: false,
      namespace: this.requireLogicalNamespace(),
      name: this.sandboxName(input.slug, input.projectId),
    });

    if (sandbox === null) {
      throw new Error(`Sandbox ${input.slug} not found.`);
    }

    return new SandboxHandle(sandbox);
  }

  async getInfo(input: { slug: string }): Promise<SandboxInfo> {
    return await (await this.get(input)).getInfo();
  }

  async getInitialized(input: { projectId?: string; slug: string }): Promise<CloudflareSandbox> {
    await this.initializedLogicalSandbox(input.slug, input.projectId);
    const sandbox = this.runtimeSandbox(input.slug, input.projectId);
    await this.mountWorkspace({ projectId: input.projectId, sandbox, slug: input.slug });
    await this.ensureIterateConfigMount({ projectId: input.projectId, sandbox });
    return sandbox;
  }

  async wake(input: { projectId?: string; slug: string }): Promise<SandboxInfo> {
    await this.getInitialized(input);
    return sandboxInfo(this.sandboxName(input.slug, input.projectId));
  }

  async exec(input: { exec: SandboxExecInput; slug: string }): Promise<ExecResult> {
    const sandbox = await this.getInitialized({ slug: input.slug });
    return await sandbox.exec(input.exec.command, toExecOptions(input.exec));
  }

  async destroyRuntime(input: { projectId?: string; slug: string }): Promise<SandboxInfo> {
    await this.get(input);
    const sandbox = this.runtimeSandbox(input.slug, input.projectId);
    await sandbox.destroy();
    return sandboxInfo(this.sandboxName(input.slug, input.projectId));
  }

  async list(input: { projectId?: string } = {}): Promise<SandboxCatalogRecord[]> {
    if (!this.env.DO_CATALOG) {
      throw new Error("DO_CATALOG binding is required to list Sandboxes.");
    }

    const records = await listD1ObjectCatalogRecordsByIndex<SandboxStructuredName>(
      this.env.DO_CATALOG,
      {
        className: "SandboxDurableObject",
        indexName: "projectId",
        indexValue: this.projectId(input.projectId),
      },
    );

    return records.map(toSandboxCatalogRecord);
  }

  private async initializedLogicalSandbox(slug: string, projectId?: string) {
    return await getInitializedDoStub({
      allowCreate: true,
      namespace: this.requireLogicalNamespace(),
      name: this.sandboxName(slug, projectId),
    });
  }

  private runtimeSandbox(slug: string, projectId?: string) {
    return getSandbox(
      this.requireRuntimeNamespace(),
      sandboxRuntimeId(this.sandboxName(slug, projectId)),
      {
        containerTimeouts: {
          instanceGetTimeoutMS: 60_000,
        },
        normalizeId: true,
        sleepAfter: "10m",
      },
    );
  }

  private async mountWorkspace(input: {
    projectId?: string;
    sandbox: CloudflareSandbox;
    slug: string;
  }) {
    try {
      await input.sandbox.mountBucket(
        this.storageBucket(),
        SANDBOX_WORKSPACE_MOUNT_PATH,
        this.mountOptions(input.slug, input.projectId),
      );
    } catch (error) {
      if (!isAlreadyMountedError(error)) throw error;
    }

    await this.ensureWorkspacePath(input.sandbox);
  }

  private async ensureWorkspacePath(sandbox: CloudflareSandbox) {
    const result = await sandbox.exec(
      [
        `if [ "$(readlink /workspace 2>/dev/null || true)" != ${shellQuote(SANDBOX_WORKSPACE_MOUNT_PATH)} ]; then`,
        "  rm -rf /workspace",
        `  ln -s ${shellQuote(SANDBOX_WORKSPACE_MOUNT_PATH)} /workspace`,
        "fi",
        "test -d /workspace",
      ].join("\n"),
      { cwd: "/", timeout: 20_000 },
    );

    if (!result.success) {
      throw new Error(`Could not prepare /workspace symlink: ${result.stderr || result.stdout}`);
    }
  }

  private async ensureIterateConfigMount(input: {
    projectId?: string;
    sandbox: CloudflareSandbox;
  }) {
    const repo = await this.iterateConfigRepo(input.projectId);
    const result = await input.sandbox.exec(artifactFsMountCommand(repo), {
      cwd: "/",
      timeout: 120_000,
    });

    if (!result.success) {
      throw new Error(
        `Could not mount iterate-config with ArtifactFS: ${result.stderr || result.stdout}`,
      );
    }
  }

  private async iterateConfigRepo(projectId?: string): Promise<RepoInfo> {
    return await getReposCapability({
      exports: this.ctx.exports,
      props: { projectId: this.projectId(projectId) },
    }).ensureIterateConfigGitAccess({ projectSlug: null });
  }

  private mountOptions(slug: string, projectId?: string) {
    const prefix = `/projects/${this.projectId(projectId)}/sandboxes/${slug}/workspace/`;
    if (this.env.SANDBOX_STORAGE_LOCAL_DEV === "true") {
      return {
        localBucket: true as const,
        prefix,
      };
    }

    return {
      endpoint: this.storageEndpoint(),
      prefix,
      ...(this.env.R2_ACCESS_KEY_ID && this.env.R2_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: this.env.R2_ACCESS_KEY_ID,
              secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    };
  }

  private storageBucket() {
    if (this.env.SANDBOX_STORAGE_LOCAL_DEV === "true") return "SANDBOX_STORAGE";
    if (!this.env.SANDBOX_STORAGE_BUCKET_NAME) {
      throw new Error("SANDBOX_STORAGE_BUCKET_NAME binding is required.");
    }
    return this.env.SANDBOX_STORAGE_BUCKET_NAME;
  }

  private storageEndpoint() {
    if (this.env.SANDBOX_STORAGE_ENDPOINT) return this.env.SANDBOX_STORAGE_ENDPOINT;
    if (!this.env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID is required to mount sandbox R2 storage.");
    }
    return `https://${this.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  }

  private requireLogicalNamespace() {
    if (!this.env.PROJECT_SANDBOX) {
      throw new Error("PROJECT_SANDBOX Durable Object namespace is not configured.");
    }

    return this.env.PROJECT_SANDBOX;
  }

  private requireRuntimeNamespace() {
    if (!this.env.SANDBOX_RUNTIME) {
      throw new Error("SANDBOX_RUNTIME Durable Object namespace is not configured.");
    }

    return this.env.SANDBOX_RUNTIME;
  }

  private sandboxName(sandboxSlug: string, projectId?: string): SandboxStructuredName {
    return {
      projectId: this.projectId(projectId),
      sandboxSlug,
    };
  }

  private projectId(projectId?: string) {
    return readProjectId({ projectId: projectId ?? this.ctx.props.projectId });
  }
}

export function getSandboxesCapability(input: {
  exports: { SandboxesCapability?: unknown } | undefined;
  props: SandboxesCapabilityProps;
}): SandboxesCapabilityClient {
  if (!input.exports?.SandboxesCapability) {
    throw new Error("SandboxesCapability export is not available.");
  }

  const sandboxesCapability = input.exports.SandboxesCapability as unknown as (options: {
    props: SandboxesCapabilityProps;
  }) => SandboxesCapabilityClient;

  return sandboxesCapability({ props: input.props });
}

function toSandboxCatalogRecord(record: SandboxLifecycleCatalogRecord): SandboxCatalogRecord {
  return {
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
    name: record.name,
    projectId: record.structuredName.projectId,
    slug: record.structuredName.sandboxSlug,
  };
}

function toExecOptions(input: SandboxExecInput): ExecOptions {
  return {
    ...(input.cwd == null ? {} : { cwd: input.cwd }),
    ...(input.env == null ? {} : { env: input.env }),
    ...(input.timeout == null ? {} : { timeout: input.timeout }),
  };
}

function readSlug(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Sandbox slug is required.");
  }

  const slug = value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Sandbox slug must be lowercase kebab-case.");
  }

  return slug;
}

function readProjectId(value: unknown) {
  if (value == null || typeof value !== "object") {
    throw new Error("projectId is required.");
  }

  const projectId = (value as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error("projectId is required.");
  }

  return projectId;
}

function isAlreadyMountedError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("already mounted") ||
    message.includes("already in use by bucket") ||
    message.includes("mount path already in use")
  );
}

function repoBearerToken(repo: RepoInfo) {
  return repo.token.includes("?expires=") ? repo.token.split("?expires=")[0] : repo.token;
}

function repoAuthorizationHeader(repo: RepoInfo) {
  return `Authorization: Bearer ${repoBearerToken(repo)}`;
}

function artifactFsMountCommand(repo: RepoInfo) {
  const script = [
    "set -eu",
    `export ARTIFACT_FS_ROOT=${shellQuote(ARTIFACT_FS_ROOT)}`,
    'mkdir -p "$ARTIFACT_FS_ROOT" /workspace',
    [
      "git",
      "config",
      "--global",
      "--replace-all",
      shellQuote(`http.${repo.remote}.extraHeader`),
      shellQuote(repoAuthorizationHeader(repo)),
    ].join(" "),
    `if ! artifact-fs status --name ${shellQuote(ITERATE_CONFIG_REPO_NAME)} >/tmp/artifact-fs-iterate-config-status.log 2>&1; then`,
    `  mkdir -p ${shellQuote(SANDBOX_ITERATE_CONFIG_PATH)}`,
    [
      "  timeout 60s artifact-fs",
      "add-repo",
      "--name",
      shellQuote(ITERATE_CONFIG_REPO_NAME),
      "--remote",
      shellQuote(repo.remote),
      "--branch",
      shellQuote(repo.defaultBranch),
      "--mount-root",
      shellQuote("/workspace"),
      ">/tmp/artifact-fs-add-repo.log 2>&1",
    ].join(" "),
    "fi",
    `if ! pgrep -f ${shellQuote("artifact-fs daemon --root /workspace")} >/dev/null; then`,
    "  nohup artifact-fs daemon --root /workspace --hydration-concurrency 4 >/tmp/artifact-fs-daemon.log 2>&1 &",
    "fi",
    [
      "for _ in $(seq 1 120); do",
      `  if mountpoint -q ${shellQuote(SANDBOX_ITERATE_CONFIG_PATH)} && git -C ${shellQuote(
        SANDBOX_ITERATE_CONFIG_PATH,
      )} rev-parse --verify HEAD >/dev/null 2>&1; then exit 0; fi`,
      "  sleep 0.25",
      "done",
      "cat /tmp/artifact-fs-iterate-config-status.log 2>/dev/null || true",
      "cat /tmp/artifact-fs-add-repo.log 2>/dev/null || true",
      "tail -n 80 /tmp/artifact-fs-daemon.log 2>/dev/null || true",
      "exit 1",
    ].join("\n"),
  ].join("\n");

  return `bash -lc ${shellQuote(script)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
