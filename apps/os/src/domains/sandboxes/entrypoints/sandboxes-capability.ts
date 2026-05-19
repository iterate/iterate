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
  SANDBOXES?: Fetcher;
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
    if (!this.env.PROJECT_SANDBOX && this.env.SANDBOXES) {
      return await this.delegateCodemodeFunctionCall(input);
    }

    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};

    switch (input.functionPath.join(".")) {
      case "create":
        return await this.createInfo({ slug: readSlug(options.slug) });
      case "destroyRuntime":
        return await this.destroyRuntime({ slug: readSlug(options.slug) });
      case "get":
      case "getInfo":
        return await this.getInfo({ slug: readSlug(options.slug) });
      case "getInitialized":
        return await this.getInitialized({ slug: readSlug(options.slug) });
      case "exec":
        return await this.exec({
          exec: readExec(options.exec),
          slug: readSlug(options.slug),
        });
      case "list":
        return await this.list();
      case "wake":
        return await this.wake({ slug: readSlug(options.slug) });
      default:
        throw new Error(`SandboxesCapability does not implement ${input.functionPath.join(".")}`);
    }
  }

  async create(input: { slug: string }) {
    return new SandboxHandle(await this.initializedLogicalSandbox(input.slug));
  }

  async createInfo(input: { slug: string }): Promise<SandboxInfo> {
    return await (await this.create(input)).getInfo();
  }

  async get(input: { slug: string }) {
    const sandbox = await getInitializedDoStub({
      allowCreate: false,
      namespace: this.requireLogicalNamespace(),
      name: this.sandboxName(input.slug),
    });

    if (sandbox === null) {
      throw new Error(`Sandbox ${input.slug} not found.`);
    }

    return new SandboxHandle(sandbox);
  }

  async getInfo(input: { slug: string }): Promise<SandboxInfo> {
    return await (await this.get(input)).getInfo();
  }

  async getInitialized(input: { slug: string }): Promise<CloudflareSandbox> {
    this.logStage("initialize.start", input.slug);
    await this.initializedLogicalSandbox(input.slug);
    this.logStage("initialize.logical-ready", input.slug);
    const sandbox = this.runtimeSandbox(input.slug);
    await this.mountWorkspace({ sandbox, slug: input.slug });
    this.logStage("initialize.workspace-mounted", input.slug);
    await this.ensureIterateConfigClone({ sandbox });
    this.logStage("initialize.iterate-config-ready", input.slug);
    return sandbox;
  }

  async wake(input: { slug: string }): Promise<SandboxInfo> {
    await this.getInitialized(input);
    return sandboxInfo(this.sandboxName(input.slug));
  }

  async exec(input: { exec: SandboxExecInput; slug: string }): Promise<ExecResult> {
    const sandbox = await this.getInitialized({ slug: input.slug });
    this.logStage("exec.start", input.slug, { cwd: input.exec.cwd });
    const result = await sandbox.exec(input.exec.command, toExecOptions(input.exec));
    this.logStage("exec.done", input.slug, { exitCode: result.exitCode });
    return result;
  }

  async destroyRuntime(input: { slug: string }): Promise<SandboxInfo> {
    await this.get(input);
    const sandbox = this.runtimeSandbox(input.slug);
    await sandbox.destroy();
    return sandboxInfo(this.sandboxName(input.slug));
  }

  async list(): Promise<SandboxCatalogRecord[]> {
    if (!this.env.DO_CATALOG) {
      throw new Error("DO_CATALOG binding is required to list Sandboxes.");
    }

    const records = await listD1ObjectCatalogRecordsByIndex<SandboxStructuredName>(
      this.env.DO_CATALOG,
      {
        className: "SandboxDurableObject",
        indexName: "projectId",
        indexValue: this.ctx.props.projectId,
      },
    );

    return records.map(toSandboxCatalogRecord);
  }

  private async initializedLogicalSandbox(slug: string) {
    return await getInitializedDoStub({
      allowCreate: true,
      namespace: this.requireLogicalNamespace(),
      name: this.sandboxName(slug),
    });
  }

  private runtimeSandbox(slug: string) {
    return getSandbox(this.requireRuntimeNamespace(), sandboxRuntimeId(this.sandboxName(slug)), {
      containerTimeouts: {
        instanceGetTimeoutMS: 60_000,
      },
      normalizeId: true,
      sleepAfter: "10m",
    });
  }

  private async mountWorkspace(input: { sandbox: CloudflareSandbox; slug: string }) {
    this.logStage("mount.start", input.slug);
    try {
      await input.sandbox.mountBucket(
        this.storageBucket(),
        "/workspace",
        this.mountOptions(input.slug),
      );
    } catch (error) {
      if (isAlreadyMountedError(error)) {
        if (await this.mountedWorkspaceIsUsable(input.sandbox)) {
          this.logStage("mount.already-mounted", input.slug);
          return;
        }

        this.logStage("mount.stale", input.slug);
        try {
          await input.sandbox.unmountBucket("/workspace");
        } catch (unmountError) {
          this.logStage("mount.stale-unmount-error", input.slug, {
            error: errorMessage(unmountError),
          });
        }
        await input.sandbox.mountBucket(
          this.storageBucket(),
          "/workspace",
          this.mountOptions(input.slug),
        );
        this.logStage("mount.remounted", input.slug);
        return;
      }
      this.logStage("mount.error", input.slug, { error: errorMessage(error) });
      throw error;
    }
    this.logStage("mount.done", input.slug);
  }

  private async mountedWorkspaceIsUsable(sandbox: CloudflareSandbox) {
    try {
      const result = await sandbox.exec("test -d /workspace && printf ok", { timeout: 10_000 });
      return result.exitCode === 0 && result.stdout.includes("ok");
    } catch {
      return false;
    }
  }

  private async ensureIterateConfigClone(input: { sandbox: CloudflareSandbox }) {
    this.logStage("iterate-config.status.start", null);
    const status = await input.sandbox.exec(
      [
        "set +e",
        `test -f ${shellQuote("/workspace/.iterate-config-ready")}`,
        "ready_marker_exit=$?",
        `test -f ${shellQuote(`${SANDBOX_ITERATE_CONFIG_PATH}/.git/HEAD`)}`,
        "git_head_exit=$?",
        "echo __ITERATE_CONFIG_READY_MARKER_EXIT__:$ready_marker_exit",
        "echo __ITERATE_CONFIG_GIT_HEAD_EXIT__:$git_head_exit",
        'if test "$ready_marker_exit" -eq 0 && test "$git_head_exit" -eq 0; then echo __ITERATE_CONFIG_READY__; fi',
      ].join("\n"),
      { timeout: 20_000 },
    );
    if (status.stdout.includes("__ITERATE_CONFIG_READY__")) {
      this.logStage("iterate-config.status.ready", null);
      return;
    }

    this.logStage("iterate-config.clone.repo.start", null);
    const repo = await this.iterateConfigRepo();
    this.logStage("iterate-config.clone.start", null);
    const token = repo.token.includes("?expires=") ? repo.token.split("?expires=")[0] : repo.token;
    const clone = await input.sandbox.exec(
      [
        "set +e",
        `rm -rf ${shellQuote(SANDBOX_ITERATE_CONFIG_PATH)}`,
        "rm_exit=$?",
        `mkdir -p ${shellQuote("/workspace")}`,
        "mkdir_exit=$?",
        [
          "git",
          "-c",
          shellQuote(`http.extraHeader=Authorization: Bearer ${token}`),
          "clone",
          "--depth",
          "1",
          "--branch",
          shellQuote(repo.defaultBranch),
          shellQuote(repo.remote),
          shellQuote(SANDBOX_ITERATE_CONFIG_PATH),
        ].join(" "),
        "clone_exit=$?",
        "echo __ITERATE_CONFIG_RM_EXIT__:$rm_exit",
        "echo __ITERATE_CONFIG_MKDIR_EXIT__:$mkdir_exit",
        "echo __ITERATE_CONFIG_CLONE_EXIT__:$clone_exit",
        `if test "$clone_exit" -eq 0; then git -C ${shellQuote(
          SANDBOX_ITERATE_CONFIG_PATH,
        )} rev-parse --verify HEAD > ${shellQuote("/workspace/.iterate-config-ready")}; fi`,
      ].join("\n"),
      { timeout: 300_000 },
    );
    if (!clone.stdout.includes("__ITERATE_CONFIG_CLONE_EXIT__:0")) {
      this.logStage("iterate-config.clone.error", null, {
        stderr: clone.stderr,
        stdout: clone.stdout,
      });
      throw new Error(
        `Could not clone iterate-config into Sandbox: ${clone.stderr || clone.stdout}`,
      );
    }
    this.logStage("iterate-config.clone.done", null);
  }

  private async iterateConfigRepo(): Promise<RepoInfo> {
    return await getReposCapability({
      exports: this.ctx.exports,
      props: { projectId: this.ctx.props.projectId },
    }).ensureIterateConfigInfo({ projectSlug: null });
  }

  private mountOptions(slug: string) {
    const prefix = `/projects/${this.ctx.props.projectId}/sandboxes/${slug}/workspace/`;
    if (this.useR2BindingSyncMount()) {
      return {
        localBucket: true as const,
        prefix,
      };
    }

    return {
      endpoint: this.storageEndpoint(),
      provider: "r2" as const,
      prefix,
      s3fsOptions: ["nonempty", "use_path_request_style"],
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
    if (this.useR2BindingSyncMount()) return "SANDBOX_STORAGE";
    if (!this.env.SANDBOX_STORAGE_BUCKET_NAME) {
      throw new Error("SANDBOX_STORAGE_BUCKET_NAME binding is required.");
    }
    return this.env.SANDBOX_STORAGE_BUCKET_NAME;
  }

  private useR2BindingSyncMount() {
    return this.env.SANDBOX_STORAGE_LOCAL_DEV === "true";
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

  private async delegateCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};
    const path = input.functionPath.join(".");

    switch (path) {
      case "create":
        return await this.callSandboxWorker({
          input: { slug: readSlug(options.slug) },
          op: "createInfo",
        });
      case "destroyRuntime":
        return await this.callSandboxWorker({
          input: { slug: readSlug(options.slug) },
          op: "destroyRuntime",
        });
      case "get":
      case "getInfo":
        return await this.callSandboxWorker({
          input: { slug: readSlug(options.slug) },
          op: "getInfo",
        });
      case "getInitialized":
      case "wake":
        return await this.callSandboxWorker({
          input: { slug: readSlug(options.slug) },
          op: "wake",
        });
      case "exec":
        return await this.callSandboxWorker({
          input: {
            exec: readExec(options.exec),
            slug: readSlug(options.slug),
          },
          op: "exec",
        });
      case "list":
        return (await this.callSandboxWorker({ op: "list" })) as {
          sandboxes: SandboxCatalogRecord[];
        };
      default:
        throw new Error(`SandboxesCapability does not implement ${path}`);
    }
  }

  private async callSandboxWorker(body: SandboxWorkerRequestWithoutProject) {
    if (!this.env.SANDBOXES) {
      throw new Error("SANDBOXES service binding is not configured.");
    }

    const response = await this.env.SANDBOXES.fetch("https://sandboxes.internal/rpc", {
      body: JSON.stringify({
        ...body,
        projectId: this.ctx.props.projectId,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const json = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        json != null &&
        typeof json === "object" &&
        "error" in json &&
        typeof json.error === "string"
          ? json.error
          : `Sandbox worker request failed with ${response.status}.`;
      throw new Error(message);
    }

    return json;
  }

  private sandboxName(sandboxSlug: string): SandboxStructuredName {
    return {
      projectId: this.ctx.props.projectId,
      sandboxSlug,
    };
  }

  private logStage(stage: string, slug: string | null, extra?: Record<string, unknown>) {
    console.log(
      JSON.stringify({
        component: "SandboxesCapability",
        projectId: this.ctx.props.projectId,
        slug,
        stage,
        ...extra,
      }),
    );
  }
}

type SandboxWorkerRequestWithoutProject =
  | {
      input: { slug: string };
      op: "createInfo" | "destroyRuntime" | "getInfo" | "wake";
    }
  | {
      input: { exec: SandboxExecInput; slug: string };
      op: "exec";
    }
  | {
      op: "list";
    };

export function getSandboxesCapability(input: {
  exports: Pick<Cloudflare.Exports, "SandboxesCapability"> | undefined;
  props: SandboxesCapabilityProps;
}): SandboxesCapabilityClient {
  if (!input.exports) {
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

function readExec(value: unknown): SandboxExecInput {
  if (value == null || typeof value !== "object") {
    throw new Error("Sandbox exec input is required.");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.command !== "string" || record.command.trim() === "") {
    throw new Error("Sandbox exec command is required.");
  }

  return {
    command: record.command,
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(isStringRecord(record.env) ? { env: record.env } : {}),
    ...(typeof record.timeout === "number" ? { timeout: record.timeout } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string | undefined> {
  if (value == null || typeof value !== "object") return false;
  return Object.values(value).every(
    (item) => typeof item === "string" || typeof item === "undefined",
  );
}

function isAlreadyMountedError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("already mounted") ||
    (message.includes("mount path") && message.includes("already in use"))
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
