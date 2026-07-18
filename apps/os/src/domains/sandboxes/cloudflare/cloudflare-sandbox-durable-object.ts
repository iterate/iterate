import type { OutboundHandler } from "@cloudflare/containers";
import { LiveStateRpcTarget } from "iterate/live-state";
import {
  type DirectoryBackup,
  type ExecEvent,
  type ExecOptions,
  type ExecResult,
  parseSSEStream,
  Sandbox,
} from "@cloudflare/sandbox";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type RegisteredProcessorReads,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../../../auth.ts";
import { workerVersion, type Env } from "../../../env.ts";
import { StreamProcessorRpcTarget, StreamRpcTarget } from "../../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../../durable-object-names.ts";
import { listIntegrationConnections } from "../../integrations/connect-flows.ts";
import { describeNode } from "../../itx/utils.ts";
import { projectStub } from "../../projects/egress.ts";
import { withWebSocketHandshakeHeaders } from "../../secrets/websocket-handshake.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../../streams/utils.ts";
import {
  SandboxProcessorContract,
  type SandboxLifecycleEventInput,
  type SandboxProcessorState,
} from "../sandbox-processor-contract.ts";
import { SandboxProcessor } from "../sandbox-processor-implementation.ts";
import { SANDBOX_INSTANCE_TYPE_BINDINGS, type SandboxInstanceType } from "../instance-types.ts";
import {
  assertSandboxPath,
  assertValidSleepAfter,
  githubTokenEnvForConnections,
  SANDBOX_GIT_CONFIG_SHELL,
} from "../utils.ts";

/**
 * The workspace root inside every sandbox container: what the backup/restore
 * cycle persists (see {@link SandboxDurableObject}). Everything under it
 * survives stop/sleep via the R2 snapshot; nothing outside it does — container
 * disk is ephemeral. Also the SDK's default working directory, so a bare
 * `exec("ls")` lists it.
 */
const SANDBOX_WORKSPACE_DIR = "/workspace";
const SANDBOX_PROCESSOR_WAIT_TIMEOUT_MS = 15_000;

/**
 * How long a sandbox's workspace backup survives without the sandbox waking
 * again. The SDK only CHECKS the ttl at restore time — it never deletes
 * expired objects from R2; actual deletion is the bucket's lifecycle rule
 * (prefix `backups/`, set by apps/os/scripts/ensure-resources.ts — keep the
 * two aligned). 90 days: long enough that any plausibly-still-wanted
 * workspace comes back intact, short enough that abandoned sandboxes do not
 * accumulate in R2 forever.
 */
const SANDBOX_BACKUP_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Durable pointer to the newest good workspace backup (a DirectoryBackup). */
const BACKUP_HANDLE_STORAGE_KEY = "iterate-sandbox-workspace-backup-v2";

/**
 * Durable env-var map for the sandbox (see {@link SandboxDurableObject}).
 * A `Record<string,string>` applied to every command in the container;
 * conventionally ALL_CAPS keys whose values are `getSecret({ path })`
 * placeholders — so the material stays in the secret system and is injected
 * only at egress, never entering the container.
 */
const SANDBOX_ENV_STORAGE_KEY = "iterate-sandbox-env";

/**
 * The durable record `create()` writes — what makes a sandbox EXIST. Every
 * command and `get()` insists on it: a sandbox is a pet, explicitly created
 * with a chosen instance type, never minted as a side effect of being
 * addressed. `destroyedAt` tombstones it permanently (Durable Object identity
 * can't be un-minted, so the record stays to make the destruction durable).
 * Deliberately does NOT copy config the SDK already persists durably
 * (sleepAfter, keepAlive, containerTimeouts — `setSleepAfter` and friends
 * write the SDK's own storage keys and its constructor restores them); a
 * second copy would go stale the moment a caller uses the SDK setters on the
 * bare stub.
 */
const SANDBOX_RECORD_STORAGE_KEY = "iterate-sandbox-record";

type SandboxRecord = {
  /** Setup has not returned successfully yet. Kept durably so a retry can
   * replay the idempotent birth batch after an ambiguous stream response. */
  creationPending?: true;
  createdAt: string;
  destroyedAt?: string;
  instanceType: SandboxInstanceType;
};

const SANDBOX_SESSION_SETUP_REDIAL_DELAYS_MS = [1_500, 3_000, 7_500, 15_000] as const;

// `@cloudflare/sandbox` 0.12.3's default-session `exec` timeout only stops
// waiting for the command. Its sessionless stream exposes the detached Linux
// process-group leader, which lets this class own a verified TERM/KILL cleanup
// before returning exit 124. This is the SDK's reserved token used by
// getSandbox({ enableDefaultSession: false }); direct Durable Object stubs do
// not pass through getSandbox, so select that execution policy explicitly.
const SANDBOX_SESSIONLESS_EXECUTION_TOKEN = "__DISABLE_SESSION__";
const SANDBOX_TIMEOUT_EXIT_CODE = 124;
const SANDBOX_PROCESS_GROUP_TERM_GRACE_SECONDS = "0.5";
const SANDBOX_PROCESS_GROUP_KILL_ATTEMPTS = 20;
const SANDBOX_PROCESS_GROUP_POLL_SECONDS = "0.05";
const SANDBOX_PROCESS_GROUP_CLEANUP_TIMEOUT_MS = 5_000;
const SANDBOX_TERMINATED_STREAM_DRAIN_TIMEOUT_MS = 5_000;

/**
 * The durable sandbox env-var map, as stored. The SDK's `setEnvVars` input
 * shape (`Record<string, string | undefined>`, undefined unsets) is the write
 * surface; storage only ever holds the defined entries.
 */
type SandboxEnvVars = Record<string, string>;

/** An env-var input map as journaled on the `configured` event: `undefined`
 * (unset) becomes an explicit `null`, because undefined values do not survive
 * JSON — and an unset should be visible in the sandbox's history. */
function definedEnvEntries(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | null> | undefined {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value === undefined ? null : value]),
  );
}

/**
 * Shell executed in a fresh sessionless process group to terminate a DIFFERENT
 * group. `ps`, rather than the group leader alone, is the source of truth: a
 * cooperative leader may exit on TERM while one of its descendants ignores
 * the signal. Zombies are already terminated and cannot execute code, so they
 * do not keep cleanup open while PID 1 gets a chance to reap them.
 */
function sandboxProcessGroupCleanupCommand(processGroupId: number): string {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error(`Invalid sandbox process-group id: ${String(processGroupId)}`);
  }

  return [
    "set -u",
    `pgid=${processGroupId}`,
    "group_has_active_processes() {",
    "  ps -eo pgid=,stat= | awk -v wanted=\"$pgid\" '$1 == wanted && $2 !~ /^Z/ { found=1 } END { exit(found ? 0 : 1) }'",
    "}",
    "wait_for_group_exit() {",
    "  attempts=$1",
    "  while group_has_active_processes; do",
    '    if test "$attempts" -le 0; then return 1; fi',
    `    sleep ${SANDBOX_PROCESS_GROUP_POLL_SECONDS}`,
    "    attempts=$((attempts - 1))",
    "  done",
    "}",
    'kill -TERM -- -"$pgid" 2>/dev/null || true',
    `sleep ${SANDBOX_PROCESS_GROUP_TERM_GRACE_SECONDS}`,
    "if ! group_has_active_processes; then exit 0; fi",
    'kill -KILL -- -"$pgid" 2>/dev/null || true',
    `if wait_for_group_exit ${SANDBOX_PROCESS_GROUP_KILL_ATTEMPTS}; then exit 0; fi`,
    "printf 'sandbox process group %s survived TERM and KILL\\n' \"$pgid\" >&2",
    "ps -eo pid=,ppid=,pgid=,stat=,args= | awk -v wanted=\"$pgid\" '$3 == wanted { print }' >&2",
    "exit 70",
  ].join("\n");
}

function appendSandboxTimeoutMessage(stderr: string, timeoutMs: number): string {
  const separator = stderr.length === 0 || stderr.endsWith("\n") ? "" : "\n";
  return `${stderr}${separator}Command timed out after ${timeoutMs}ms`;
}

// The two `readFile` result types (`ReadFileResult`, and the `encoding: "none"`
// stream result) are not exported by the SDK, so recover them from the
// overloaded base signature rather than mirroring the interfaces (which would
// drift). `ReturnType` collapses to the last overload, so match BOTH call
// signatures in one conditional and `infer` each return — this is what lets the
// override below restate the overloads with the SDK's exact types.
type ReadFileReturns = Sandbox<Env>["readFile"] extends {
  (path: string, options: { encoding: "none"; sessionId?: string }): infer Stream;
  (
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64"; sessionId?: string },
  ): infer Buffered;
}
  ? { stream: Stream; buffered: Buffered }
  : never;

// The container-outbound handler runs in the ContainerProxy WorkerEntrypoint,
// not on a sandbox instance, so it only gets the container's opaque Durable
// Object id — not the project it belongs to. This isolate-local cache turns
// that id into a projectId with at most one lookup per sandbox per isolate;
// the lookup itself dials the sandbox for its durable identity.
const projectIdByContainerId = new Map<string, string>();

/**
 * Whether an error is the SDK's "session SETUP was interrupted" case — the
 * per-command `utils.createSession` dial died to a transport disposal or a
 * runtime replacement, so the command itself was never admitted and a retry
 * is provably safe. Reads the fields off the error instance (the SDK's
 * SandboxError exposes `code`/`context` as getters) AND off the raw
 * `errorResponse` it wraps, so a plain-object or re-serialized form of the
 * same error (getters don't survive serialization) still matches.
 */
function isInterruptedSessionSetup(error: unknown): boolean {
  const shape = error as {
    code?: string;
    context?: { operation?: string; reason?: string };
    errorResponse?: { code?: string; context?: { operation?: string; reason?: string } };
  };
  const code = shape?.code ?? shape?.errorResponse?.code;
  const context = shape?.context ?? shape?.errorResponse?.context;
  return (
    code === "OPERATION_INTERRUPTED" &&
    context?.operation === "utils.createSession" &&
    (context.reason === "transport_disposed" || context.reason === "runtime_replaced")
  );
}

async function resolveEgressProjectId(
  env: Env,
  containerId: string,
  instanceType: SandboxInstanceType,
): Promise<string> {
  const cached = projectIdByContainerId.get(containerId);
  if (cached !== undefined) return cached;
  const binding = SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].binding as keyof Env;
  const namespace = env[binding] as DurableObjectNamespace<SandboxDurableObject>;
  const stub = namespace.get(namespace.idFromString(containerId));
  const projectId = await stub.egressProjectId();
  projectIdByContainerId.set(containerId, projectId);
  return projectId;
}

/**
 * The catch-all container-egress handler, per instance type: EVERY outbound
 * request a sandbox container makes (HTTP and, via `interceptHttps`, HTTPS)
 * arrives here and is forwarded to the owning project's Durable Object — the
 * same decision point `ProjectEgressEntrypoint` gives dynamic workers. There
 * is no direct internet path: a sandbox reaches the outside world only
 * through project egress policy. Runs in the ContainerProxy WorkerEntrypoint
 * (no sandbox `this`), so the project is recovered from the container id via
 * the instance type's own namespace — which is why the handler is minted per
 * instance type (closing over it) rather than shared.
 *
 * The containers SDK keys its outbound registry by CLASS NAME, and a
 * container instance looks its handler up under `this.constructor.name` — so
 * every subclass below must register its handler itself (a registration on
 * the base class would sit under the base class's name and never be found).
 * Each subclass does so in a static BLOCK, not as `static outbound = …`:
 * `outbound` is a static accessor whose setter performs the registration,
 * and under `useDefineForClassFields` (our ES2024 target) a `static` field
 * would DEFINE an own data property that shadows the accessor — the setter
 * never runs, nothing registers, and every request silently falls through to
 * a direct `fetch` (TLS still MITM'd, but egress bypasses project policy).
 *
 * WebSocket upgrades use the same project egress door. Project and Secret DOs
 * pass through the upstream socket opened after policy and substitution; this
 * final boundary replaces only the hop-specific client handshake headers.
 */
function sandboxOutboundFor(instanceType: SandboxInstanceType): OutboundHandler<Env> {
  return async (request, env, ctx) => {
    const projectId = await resolveEgressProjectId(env, ctx.containerId, instanceType);
    const response = await projectStub(env.PROJECT, projectId).fetch(request);
    // Container intercept converts Response.webSocket → HTTP 101 for the
    // in-container client. Stamp Accept for this caller's key and leave frame
    // transport to the native WebSocket response path.
    return withWebSocketHandshakeHeaders(request, response);
  };
}

/**
 * The sandbox's own address, as carried by its Durable Object name:
 * which project it belongs to and its path (always `/sandboxes/<name>`).
 */
type SandboxIdentity = { path: string; projectId: string };

type SandboxProcessorResources = {
  reads: RegisteredProcessorReads<SandboxProcessorState>;
  registry: StreamProcessorRegistry<SandboxProcessorState>;
};

const IDENTITY_STORAGE_KEY = "iterate-sandbox-identity";

/**
 * A project-scoped Cloudflare Sandbox: the `@cloudflare/sandbox` container
 * Durable Object, addressed like every other domain object
 * (`{projectId}.iterate{path}` in the size's namespace). The public surface
 * IS the SDK's — `itx.sandboxes.get(path)` returns this object's bare RPC
 * stub (exec, files, processes, ports, gitCheckout, …) with nothing wrapped
 * on top — plus the explicit lifecycle verbs below.
 *
 * Sandboxes are PETS: they exist only after an explicit
 * `itx.sandboxes.create({ name, instanceType })` (get() refuses paths that
 * were never created), their instance type is fixed for life (it is a path
 * segment, and Cloudflare fixes instance type per container class — see
 * instance-types.ts), and their lifecycle is imperative — `start()`,
 * `sleep()`, `destroy()` — with every command and completion appended as
 * events to the stream at the sandbox's own path (see the contract in
 * sandbox-processor-contract.ts).
 *
 * This class is abstract; one concrete subclass per instance type (bottom of
 * this file) is what wrangler binds as a container class. All behavior lives
 * here.
 *
 * Three behaviors are added over the stock SDK class:
 *
 * 1. EXPLICIT EXISTENCE. `create()` writes the durable record; every public
 *    command asserts it (and that the sandbox wasn't destroyed). `destroy()`
 *    tombstones the record permanently — the SDK's container-level destroy
 *    stays in use internally (idle teardown, sleep()) without ending the pet.
 *
 * 2. `/workspace` PERSISTS ACROSS SLEEP. Container disk is ephemeral —
 *    Cloudflare offers no persistent volume
 *    (https://developers.cloudflare.com/containers/faq/) — so this class uses
 *    the Sandbox SDK's backup/restore
 *    (https://developers.cloudflare.com/sandbox/guides/backup-restore/): an
 *    explicit `sleep()` and the idle timer both snapshot `/workspace` to the
 *    env's {@link Env.BACKUP_BUCKET} R2 bucket, and the next start restores
 *    the newest snapshot. Snapshots exclude node_modules explicitly and honor
 *    gitignore rules where the SDK finds a git checkout, keeping them small
 *    and restores fast. Snapshot-granular: a container that CRASHES loses
 *    whatever changed since the last snapshot — durable work belongs in a
 *    repo, committed and pushed. (`mountBucket` would persist continuously
 *    but its `r2.internal` traffic cannot coexist with the catch-all egress
 *    interception below — verified broken live, hence the fence below;
 *    backup transfers are plain HTTPS through project egress.)
 *
 * 3. ALL container egress is routed through the project's egress decision
 *    point, exactly like a dynamic worker's `globalOutbound` — see
 *    {@link sandboxOutbound}. `interceptHttps` extends that to HTTPS by
 *    man-in-the-middling TLS with the Cloudflare-provided container CA (the
 *    stock `@cloudflare/sandbox` image installs it at start when
 *    `SANDBOX_INTERCEPT_HTTPS` is set, which the SDK sets from this flag), so
 *    a sandbox cannot reach the internet except through project policy.
 */
export abstract class SandboxDurableObject extends Sandbox<Env> {
  // Intercept HTTPS as well as HTTP: without this, only plaintext egress would
  // reach the `outbound` handler and TLS traffic would bypass project policy.
  override interceptHttps = true;

  // Tag every instance for the Containers dashboard/analytics, so sandbox
  // instances are filterable apart from any other container class in the
  // account. Static (app/component); per-sandbox identity already lives in the
  // Durable Object name and the lifecycle stream. See docs/cloudflare-sandboxes.md.
  override labels = { app: "iterate-os", component: "sandbox" };

  // Preserve strict create semantics while one attempt is still executing in
  // this incarnation. A durable pending record is resumable only after that
  // attempt has failed (or the object restarted), not by a concurrent caller.
  #creationInFlight = false;

  // Container-backed Durable Objects do not reliably expose ctx.id.name in
  // local development, so processor plumbing is initialized lazily after the
  // collection has recorded the sandbox identity (see #ensureIdentity).
  #processorResourcesValue: SandboxProcessorResources | undefined;

  #processorResources(): SandboxProcessorResources {
    if (this.#processorResourcesValue !== undefined) return this.#processorResourcesValue;
    const { path, projectId } = this.#identity();
    const stream = new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path,
      projectId,
    });
    const registry = createStreamProcessorRegistry<SandboxProcessorState>(this.ctx, {
      stream,
      path,
      projectId,
      version: workerVersion(this.env),
    });
    // Pure fold: there is no consequential background work to recover after
    // eviction, so this processor deliberately does not opt into recovery.
    const processor = registry.register(new SandboxProcessor({ stream, path, projectId }));
    const resources = { reads: registry.reads(processor), registry };
    this.#processorResourcesValue = resources;
    return resources;
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorResources().registry.wakeStreamSubscriber(args);
  }

  // Do not override alarm(): @cloudflare/containers owns this object's one
  // alarm for container scheduling and idle expiry. The pure-fold processor
  // above has recovery disabled and therefore never arms a registry alarm.

  get processor() {
    const { reads, registry } = this.#processorResources();
    return new StreamProcessorRpcTarget(reads, {
      catchUpBeforeSnapshot: () => registry.catchUp(SandboxProcessorContract.slug),
    });
  }

  get liveState() {
    return new LiveStateRpcTarget<SandboxProcessorState>(this.#processorResources().registry);
  }

  /** Each subclass declares its instance type here — a STATIC field, not the
   * class name (a bundler may rename classes) and not an instance field
   * (those initialize after the base constructor runs). */
  protected static sandboxInstanceType: SandboxInstanceType;

  /** This class's instance type, from the subclass's static declaration. */
  #instanceType(): SandboxInstanceType {
    const instanceType = (this.constructor as typeof SandboxDurableObject).sandboxInstanceType;
    if (instanceType === undefined) {
      throw new Error(
        `sandbox class "${this.constructor.name}" declares no instance type — see instance-types.ts`,
      );
    }
    return instanceType;
  }

  /**
   * This sandbox's project, for the egress handler. A plain read of the
   * durable identity — the handler cannot see the Durable Object name, only
   * the id, so it asks the instance who it belongs to.
   */
  async egressProjectId(): Promise<string> {
    return this.#identity().projectId;
  }

  /**
   * Abort the current Durable Object incarnation; the next request boots it
   * again. Journal and fold the operator intent first: `ctx.abort()` is
   * necessarily observed by Cloudflare and the caller as a lifecycle reset,
   * so the sandbox stream must carry the durable explanation for that reset.
   */
  async kill(): Promise<void> {
    this.#assertUsable();
    await this.#appendLifecycleEventAndWait({
      type: "events.iterate.com/sandbox/kill-requested",
      payload: {},
    });
    this.ctx.abort("kill requested");
  }

  /**
   * Create the sandbox: write the durable record that makes it exist. The
   * instance type is validated against THIS class (the collection routed here
   * by the type it journaled on `create-requested`) and fixed for life.
   * Strict once setup completes — a pet is born once; an existing or
   * destroyed path is an error, so two callers can't silently share a sandbox
   * they each think they created. The sole exception is a durable
   * `creationPending` record: it means a previous attempt failed before setup
   * returned, so replay the idempotent birth batch and finish that same
   * catalogue claim instead of stranding half-created state.
   *
   * `sleepAfter` and `keepAlive` pass straight through to the SDK's own
   * durable setters (`setSleepAfter` / `setKeepAlive` — the SDK persists and
   * restores them itself); `env` merges as if by {@link setEnvVars}. The
   * collection journals `create-requested` (the command) before calling;
   * this emits `created` (the completion). No container boots here — the
   * first command or an explicit `start()` does.
   */
  async create(input: {
    env?: Record<string, string | undefined>;
    instanceType: SandboxInstanceType;
    keepAlive?: boolean;
    path: string;
    projectId: string;
    sleepAfter?: string | number;
  }): Promise<{ createdAt: string; instanceType: SandboxInstanceType; path: string }> {
    if (input.instanceType !== this.#instanceType()) {
      throw new Error(
        `sandbox instance-type mismatch: this namespace hosts "${this.#instanceType()}" sandboxes, got "${input.instanceType}"`,
      );
    }
    // Validate BEFORE any durable write: a bad sleepAfter must reject the
    // create outright, not burn the name (record written) or wedge the DO
    // (see assertValidSleepAfter).
    if (input.sleepAfter !== undefined) assertValidSleepAfter(input.sleepAfter);
    this.#ensureIdentity({ path: input.path, projectId: input.projectId });
    if (this.#creationInFlight) {
      throw new Error(`sandbox "${input.path}" creation is already in progress`);
    }
    const existing = this.#record();
    if (existing?.destroyedAt !== undefined) {
      throw new Error(
        `sandbox "${input.path}" was destroyed and its name cannot be reused — create one with a new name`,
      );
    }
    if (existing !== undefined && existing.creationPending !== true) {
      throw new Error(
        `sandbox "${input.path}" already exists — itx.sandboxes.get("${input.path}") to use it`,
      );
    }
    if (existing?.instanceType !== undefined && existing.instanceType !== input.instanceType) {
      throw new Error(
        `sandbox instance-type mismatch while resuming creation: expected "${existing.instanceType}", got "${input.instanceType}"`,
      );
    }
    const record: SandboxRecord =
      existing ??
      ({
        creationPending: true,
        createdAt: new Date().toISOString(),
        instanceType: input.instanceType,
      } satisfies SandboxRecord);
    if (existing === undefined) {
      this.ctx.storage.kv.put(SANDBOX_RECORD_STORAGE_KEY, record);
    }
    this.#creationInFlight = true;
    try {
      // Birth and the processor subscription are one batch, and create returns
      // only after the hosted reducer has durably folded through both facts.
      // Keep the pending record if append, fold, or configuration fails: stream
      // RPC failures are ambiguous, and deleting it after a committed append
      // would leave a stream-visible ghost with no command record. Both birth
      // events are idempotency-keyed, so the next create retry safely heals the
      // same catalogue claim and waits for the same reducer boundary.
      await this.#appendBirth(input.instanceType);
      if (input.sleepAfter !== undefined) await this.setSleepAfter(input.sleepAfter);
      if (input.keepAlive !== undefined) await this.setKeepAlive(input.keepAlive);
      if (input.env !== undefined && Object.keys(input.env).length > 0) {
        await this.setEnvVars(input.env);
      }
      const current = this.#record();
      if (current === undefined) {
        throw new Error(`sandbox "${input.path}": creation record disappeared during setup`);
      }
      if (current.destroyedAt !== undefined) {
        throw new Error(`sandbox "${input.path}" was destroyed while creation was finishing`);
      }
      const { creationPending: _creationPending, ...completedRecord } = current;
      this.ctx.storage.kv.put(SANDBOX_RECORD_STORAGE_KEY, completedRecord);
      return {
        createdAt: record.createdAt,
        instanceType: record.instanceType,
        path: this.#identity().path,
      };
    } finally {
      this.#creationInFlight = false;
    }
  }

  /**
   * What `itx.sandboxes.get(path)` awaits before handing out the stub:
   * getting a sandbox never creates one, so a path that was never created (or
   * was destroyed) is refused here. Also verifies identity — see
   * {@link #ensureIdentity}.
   */
  async assertCreated(identity: SandboxIdentity): Promise<void> {
    // Usability FIRST: get() on a never-created path must not leave identity
    // storage behind (addressing never creates, not even at the storage
    // level). #ensureIdentity then only verifies-or-records for a sandbox
    // that provably exists.
    if (this.#usableRecord().creationPending === true) {
      throw new Error(
        `sandbox "${identity.path}" creation did not finish — retry itx.sandboxes.create with the original input`,
      );
    }
    this.#ensureIdentity(identity);
  }

  /**
   * The SDK's `setSleepAfter`, guarded: validate before the SDK persists the
   * raw value (see {@link assertValidSleepAfter} — an unparseable stored
   * value crash-loops the DO constructor forever). Callers hold the bare
   * stub, so the fence must live here, not just in `create`.
   */
  override async setSleepAfter(sleepAfter: string | number): Promise<void> {
    assertValidSleepAfter(sleepAfter);
    return super.setSleepAfter(sleepAfter);
  }

  /**
   * The capability-tree `__describe()` convention, answered by the sandbox
   * itself: instructions for a model-eyed caller plus the durable record as
   * structured extras (`sandbox`). sleepAfter is read live off the SDK's own
   * durable field, so it can never go stale against a caller using the SDK's
   * `setSleepAfter` directly. Touches no container.
   */
  async __describe() {
    const record = this.#usableRecord();
    const { path } = this.#identity();
    return describeNode({
      instructions:
        `The sandbox at "${path}" — a real Linux container (Cloudflare instance type ` +
        `${record.instanceType}, fixed for life), the bare Cloudflare Sandbox SDK surface ` +
        `(https://developers.cloudflare.com/sandbox/api/) plus start()/sleep()/destroy(). ` +
        `Only /workspace survives sleep (snapshot-restored); setEnvVars is durable here and ` +
        `values should be getSecret placeholders. Current sleepAfter: ${this.sleepAfter}.`,
      parent: "itx.sandboxes.get(path)",
      sandbox: {
        createdAt: record.createdAt,
        instanceType: record.instanceType,
        path,
        sleepAfter: this.sleepAfter,
      },
    });
  }

  /**
   * Boot the container now, rather than lazily on the first command: restores
   * `/workspace` from the newest snapshot and applies the env-var map, so a
   * follow-up command sees a warm, provisioned sandbox. Idempotent while
   * running. Emits `start-requested`; the boot itself lands as `started` (the
   * onStart hook — which also fires for implicit wakes). The boot is forced
   * by `#ensureWorkspaceCurrent`'s cold-path no-op exec — on a fresh sandbox
   * there is no snapshot to restore and env application alone never starts a
   * container.
   */
  async start(): Promise<void> {
    this.#assertUsable();
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/start-requested",
      payload: {},
    });
    await this.#ensureWorkspaceCurrent();
    // onStart cannot wait for the processor while it is inside the SDK's
    // blockConcurrencyWhile budget. The ordinary command boundary can: do
    // not return a successful start while the live controls still see the
    // pre-start `running` projection.
    await this.#catchUpLifecycleCompletion(this.#lastStartedOffset);
  }

  /** Recreate the running container while preserving `/workspace`. */
  async restart(): Promise<void> {
    this.#assertUsable();
    await this.sleep();
    await this.start();
  }

  /**
   * Put the sandbox to sleep NOW: snapshot `/workspace` to R2, then tear the
   * container down. "Sleep" is Cloudflare's own word for what the idle timer
   * does after `sleepAfter` — this is the on-demand form, plus our snapshot.
   * The SANDBOX stays created — the next `start()` (or any command) boots a
   * fresh container and restores the snapshot.
   *
   * Teardown is the SDK's container-level destroy, not its stop (SIGTERM): a
   * stopped container keeps its instance ASSIGNED to this Durable Object, and
   * assignments count against the class's max_instances and never expire on
   * their own — observed live as the recurring "Container is starting"
   * wedges. Destroy releases the slot; the snapshot makes the two land in the
   * same place (Durable Object storage — identity, record, backup handle —
   * survives either way).
   */
  async sleep(): Promise<void> {
    this.#assertUsable();
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/sleep-requested",
      payload: {},
    });
    try {
      await this.#backupWorkspace();
    } catch (error) {
      console.error("sandbox workspace backup failed during sleep", error);
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/backup-failed",
        payload: { error: String(error) },
      });
    }
    await super.destroy(); // container-level: the onStop hook appends `stopped`
    this.#invalidateWorkspaceMemo();
    // Match start(): the lifecycle hook only makes `stopped` durable, while
    // this unconstrained command boundary waits for its reduced projection.
    await this.#catchUpLifecycleCompletion(this.#lastStoppedOffset);
  }

  /**
   * The SDK's `stop(signal?)` forwards to {@link sleep} (the signal is
   * dropped). Two reasons: the SDK's SIGTERM stop leaks the instance
   * assignment (see sleep), and a docs-reading caller invoking `stop()` must
   * not get a snapshot-less teardown that silently loses `/workspace` back to
   * the previous backup.
   */
  override async stop(..._args: Parameters<Sandbox<Env>["stop"]>): Promise<void> {
    await this.sleep();
  }

  /**
   * Destroy the sandbox PERMANENTLY: tear the container down and tombstone
   * the durable record — `get()` and every command refuse the path forever
   * after (Durable Object identity cannot be re-minted, so the name is
   * retired rather than recycled). No parting snapshot: destroyed means gone;
   * existing R2 snapshots age out on their ttl. Idempotent — a second destroy
   * is a no-op, so cleanup paths can call it blindly.
   */
  override async destroy(): Promise<void> {
    const record = this.#record();
    if (record === undefined) {
      throw new Error("sandbox was never created — nothing to destroy");
    }
    if (record.destroyedAt !== undefined) return;
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/destroy-requested",
      payload: {},
    });
    // Teardown BEFORE the tombstone: if the container teardown throws, the
    // record stays live and a retry runs the whole destroy again — tombstoning
    // first would make the retry hit the idempotent early-return above and
    // leave a running container behind a dead pet. A command sneaking in
    // between teardown and tombstone at worst boots a container that the next
    // idle expiry reclaims.
    await super.destroy();
    this.#invalidateWorkspaceMemo();
    // Fold the terminal fact before tombstoning. Stream delivery reaches this
    // processor through the collection without requiring a usable sandbox,
    // but returning only after the fold gives callers a coherent final state.
    await this.#appendLifecycleEventAndWait({
      type: "events.iterate.com/sandbox/destroyed",
      payload: {},
    });
    this.ctx.storage.kv.put(SANDBOX_RECORD_STORAGE_KEY, {
      ...record,
      destroyedAt: new Date().toISOString(),
    });
  }

  /**
   * Idle expiry: SNAPSHOT `/workspace`, then tear the container down — the
   * automatic form of {@link stop}. This is the one moment a pre-sleep
   * snapshot is possible — the idle timer fired but the container is STILL
   * RUNNING (`onStop` is too late: the container is already gone, and that
   * hook can even fire on a later wake). A backup failure must never wedge
   * the container alive — it holds an instance slot against the class cap —
   * so failures are logged and emitted as events, and the teardown proceeds
   * regardless; the durable handle still points at the last good backup.
   * The SDK's keepAlive guard is preserved (its own override skips shutdown
   * when a caller enabled keepAlive; the field is private, hence the cast).
   */
  override async onActivityExpired(): Promise<void> {
    const keepAlive = (this as unknown as { keepAliveEnabled?: boolean }).keepAliveEnabled === true;
    if (keepAlive) {
      return super.onActivityExpired();
    }
    // The SDK's default hook stops the container the instant the idle alarm
    // fires; ours runs a backup FIRST, which takes seconds to tens of seconds
    // — plenty of time for a new call to land. Destroying then would tear the
    // RPC transport down under that call (observed live as OPERATION_INTERRUPTED
    // / transport_disposed on utils.createSession). The SDK counts in-flight
    // session work on `inflightRequests` (undeclared in the d.ts, hence the
    // cast); if anything is in flight before or after the backup, the sandbox
    // is not idle — skip the teardown and let the renewed activity re-arm the
    // idle alarm (the next expiry snapshots again, so nothing is lost).
    const busy = () =>
      ((this as unknown as { inflightRequests?: number }).inflightRequests ?? 0) > 0;
    if (busy()) return;
    try {
      await this.#backupWorkspace();
    } catch (error) {
      console.error("sandbox workspace backup failed", error);
      this.#emitLifecycleEvent({
        type: "events.iterate.com/sandbox/backup-failed",
        payload: { error: String(error) },
      });
    }
    if (busy()) return;
    await super.destroy();
    this.#invalidateWorkspaceMemo();
  }

  /**
   * Record who this sandbox is before any other traffic reaches it.
   *
   * Identity normally derives from the Durable Object name, but container
   * runtimes do not reliably surface `ctx.id.name` (the local dev runtime
   * drops it) — the `@cloudflare/sandbox` SDK pushes its name in through
   * `getSandbox()` for the same reason. `create()` writes it before the
   * record, so identity is always in place by the time a container start
   * needs it.
   *
   * Identity is WRITE-ONCE: if it re-wrote storage, a caller could point an
   * already-named sandbox at a different project. The first write comes from
   * the collection's `create`, which derived the identity from the caller's
   * authority; everything after must match it (and must match `ctx.id.name`
   * whenever the runtime provides it).
   */
  #ensureIdentity(identity: SandboxIdentity): void {
    const path = assertSandboxPath(identity.path);
    const expectedName = DurableObjectNameCodec.stringify({
      projectId: identity.projectId,
      path,
    });
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== expectedName) {
      throw new Error(
        `sandbox identity mismatch: durable object is named "${this.ctx.id.name}", got "${expectedName}"`,
      );
    }
    const stored = this.ctx.storage.kv.get<SandboxIdentity>(IDENTITY_STORAGE_KEY);
    if (stored !== undefined) {
      if (stored.projectId !== identity.projectId || stored.path !== path) {
        throw new Error(
          `sandbox identity mismatch: this sandbox is "${stored.projectId}:${stored.path}", got "${identity.projectId}:${path}"`,
        );
      }
      return;
    }
    this.ctx.storage.kv.put(IDENTITY_STORAGE_KEY, { path, projectId: identity.projectId });
  }

  #identity(): SandboxIdentity {
    const name = this.ctx.id.name;
    if (name !== undefined) {
      const parsed = DurableObjectNameCodec.parse(name);
      return { path: assertSandboxPath(parsed.path), projectId: parsed.projectId };
    }
    const stored = this.ctx.storage.kv.get<SandboxIdentity>(IDENTITY_STORAGE_KEY);
    if (!stored) {
      throw new Error(
        "sandbox has no identity yet — create it with itx.sandboxes.create, not a raw stub",
      );
    }
    return stored;
  }

  #record(): SandboxRecord | undefined {
    return this.ctx.storage.kv.get<SandboxRecord>(SANDBOX_RECORD_STORAGE_KEY);
  }

  /** The record, insisting the sandbox exists and wasn't destroyed — the
   * gate every command and `get()` passes through. */
  #usableRecord(): SandboxRecord {
    const record = this.#record();
    if (record === undefined) {
      throw new Error(
        "sandbox does not exist — sandboxes are created explicitly: itx.sandboxes.create({ name, instanceType })",
      );
    }
    if (record.destroyedAt !== undefined) {
      throw new Error(
        `sandbox was destroyed at ${record.destroyedAt} and its name cannot be reused — create one with a new name`,
      );
    }
    return record;
  }

  #assertUsable(): void {
    this.#usableRecord();
  }

  #workspaceReady: Promise<void> | undefined;
  #lastStartedOffset: number | undefined;
  #lastStoppedOffset: number | undefined;
  // Whether the CURRENT container's workspace was fully provisioned (snapshot
  // restored, env applied). Gates the idle-time backup: snapshotting a
  // half-provisioned workspace would overwrite the pointer to the last GOOD
  // backup.
  #workspaceProvisioned = false;

  override async onStart(): Promise<void> {
    await super.onStart();
    // Each start is a fresh container process (empty disk), so a readiness
    // promise or provisioned flag from a previous container must not satisfy
    // this one. Provisioning itself is NOT kicked off here:
    //
    // - It cannot run inline — `onStart` executes in the container framework's
    //   blockConcurrencyWhile, which has a hard ~30s budget and resets the
    //   Durable Object on overrun (verified live), and a large restore can
    //   exceed it.
    // - A background kick would be redundant AND racy: every workspace-touching
    //   command is guarded by `#ensureReady()` (see the overrides below), so
    //   nothing can observe the workspace before provisioning anyway — and
    //   when a guard's own restore is what booted this container, an eager
    //   kick here would spawn a SECOND provisioning run concurrent with the
    //   guard's in-flight one.
    this.#workspaceReady = undefined;
    this.#workspaceProvisioned = false;
    // Invalidate before touching the stream: even if journaling fails and the
    // hook rejects, no later call may reuse readiness from the old container.
    this.#lastStartedOffset = await this.#appendLifecycleEventAndCatchUpInBackground({
      type: "events.iterate.com/sandbox/started",
      payload: {},
    });
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    // May fire late: if the Durable Object was hibernated when the container
    // exited, the SDK delivers this on the next wake — BEFORE the next boot's
    // onStart, so invalidating here can't clobber a newer container's memo.
    // This covers container crashes while the DO stays resident: without it
    // the memo would keep describing a container that no longer exists.
    this.#invalidateWorkspaceMemo();
    this.#lastStoppedOffset = await this.#appendLifecycleEventAndCatchUpInBackground({
      type: "events.iterate.com/sandbox/stopped",
      payload: {},
    });
  }

  /**
   * Forget the current container's provisioning. MUST run after every
   * teardown this class performs (sleep, idle expiry, destroy) and on
   * onStop: the DO instance survives a container destroy, and a memo left
   * behind would satisfy the next command's guard against a container that
   * no longer exists — the command would then run on a fresh UNRESTORED
   * disk (reads see nothing; its writes get clobbered by the eventual
   * restore, or worse, an explicit sleep() would snapshot the empty
   * /workspace over the last good backup).
   */
  #invalidateWorkspaceMemo(): void {
    this.#workspaceReady = undefined;
    this.#workspaceProvisioned = false;
  }

  /**
   * Snapshot `/workspace` to R2 and move the durable handle to the new backup.
   * node_modules is excluded explicitly (gitignore rules apply only where the
   * SDK finds a git checkout, and `/workspace` itself is not one), so archives
   * stay small and restores fast; reinstalling dependencies is the restored
   * workspace's job. The handle is only overwritten AFTER `createBackup`
   * succeeds, so a failed backup can never orphan the previous good snapshot.
   *
   * Transfer mode is chosen by what the env provides: with R2 S3 credentials
   * the SDK presigns `*.r2.cloudflarestorage.com` URLs and the container
   * transfers directly (fast, and through project egress like all container
   * traffic); without them — local dev always, a deployed env until keys are
   * minted — archives stream through the Durable Object's BACKUP_BUCKET
   * binding (the SDK's `localBucket` mode: slower, but zero-config and the
   * only mode `wrangler dev` supports).
   */
  async #backupWorkspace(): Promise<void> {
    if (!this.#workspaceProvisioned) return;
    // Belt and braces over the memo: never snapshot when no container is
    // running — the SDK's createBackup would boot a FRESH (empty, unrestored)
    // container on demand and archive its empty /workspace over the last good
    // backup. Nothing ran since the last snapshot, so there is nothing new to
    // save anyway.
    if (this.ctx.container?.running !== true) return;
    const { projectId, path } = this.#identity();
    const backup = await this.createBackup({
      dir: SANDBOX_WORKSPACE_DIR,
      name: `${projectId}${path}`,
      ttl: SANDBOX_BACKUP_TTL_SECONDS,
      gitignore: true,
      excludes: ["node_modules"],
      ...(this.#canPresignBackupTransfers() ? {} : { localBucket: true }),
    });
    this.ctx.storage.kv.put(BACKUP_HANDLE_STORAGE_KEY, backup);
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/backup-created",
      payload: { backupId: backup.id },
    });
  }

  #canPresignBackupTransfers(): boolean {
    return Boolean(
      this.env.R2_ACCESS_KEY_ID &&
      this.env.R2_SECRET_ACCESS_KEY &&
      this.env.CLOUDFLARE_R2_ACCOUNT_ID,
    );
  }

  /**
   * Restore the newest workspace backup into the fresh container, if one
   * exists. Returns the restored backup's id, or null when nothing was
   * restored; any failure (expired ttl, deleted object, transfer error)
   * degrades to null so provisioning continues with an empty workspace rather
   * than failing the start. Emits nothing — `#ensureWorkspace` reports what
   * happened once provisioning completes, behind its run-identity guard, so a
   * superseded run can't journal a restore for a container it no longer owns.
   */
  async #restoreWorkspace(): Promise<string | null> {
    const backup = this.ctx.storage.kv.get<DirectoryBackup>(BACKUP_HANDLE_STORAGE_KEY);
    if (backup === undefined) return null;
    try {
      // Same redial as every command: an interrupted SESSION dial means the
      // restore never started, and giving up would silently discard a valid
      // snapshot.
      const result = await this.#redialOnInterruptedSessionSetup(() => this.restoreBackup(backup));
      return result.success ? backup.id : null;
    } catch (error) {
      console.warn("sandbox workspace restore failed; starting with an empty workspace", error);
      return null;
    }
  }

  /**
   * The workspace guarantee, awaitable: resolves once the CURRENT container is
   * provisioned — the newest snapshot restored into `/workspace` and the
   * durable env-var map applied. Loops because a container restart mid-await
   * resets `#workspaceReady` (fresh disk): a promise that completed against
   * the PREVIOUS container must not satisfy this call.
   *
   * On a COLD ensure (no memo), the container is booted with a no-op exec
   * BEFORE the provisioning run is registered. Booting inside the run would
   * fire `onStart` mid-run, which resets the memo and marks the run stale —
   * so every cold boot with a backup would restore twice (once discarded).
   * Pre-booting means the run's own restore lands on an already-running
   * container and only a REAL mid-run crash invalidates it. The warm path
   * (memo present) skips the exec entirely.
   */
  async #ensureWorkspaceCurrent(): Promise<void> {
    while (true) {
      if (this.#workspaceReady === undefined) {
        await this.#redialOnInterruptedSessionSetup(() => super.exec(":"));
      }
      const run = this.#ensureWorkspace();
      await run;
      if (this.#workspaceReady === run) return;
    }
  }

  /**
   * The SDK's `setEnvVars`, made DURABLE — the one deliberate semantic
   * upgrade to an SDK method. The stock implementation only mutates the
   * running container's in-memory map (nothing survives a restart); ours
   * persists the merge in Durable Object storage, re-applies it on every
   * container start, and journals a `sandbox/configured` event. Same
   * signature and semantics otherwise: keys merge in, `undefined` unsets a
   * key. Keeping the SDK's name (rather than a bespoke `configureEnvVars`)
   * means a docs-reading caller can't pick the silently-non-durable spelling.
   *
   * The intended value shape is a `getSecret({ path })` placeholder: the
   * material then stays in the secret system and is substituted only at egress
   * (the project egress path already does this for any header carrying the
   * placeholder), so code in the sandbox can read e.g. `OPENAI_API_KEY` from
   * the environment and call the provider, yet the real key never enters the
   * container. Plain non-secret values are fine too. NEVER pass raw secret
   * material — it would sit in the container's environment, its snapshots,
   * and the `configured` event on the durable stream.
   *
   * Valid before the container ever boots: the map is persisted now and
   * re-applied during provisioning; if a container is already running, the
   * delta is applied to it immediately (best-effort — never fail
   * configuration on a transient container hiccup).
   */
  override async setEnvVars(vars: Record<string, string | undefined>): Promise<void> {
    this.#assertUsable();
    const stored = this.ctx.storage.kv.get<SandboxEnvVars>(SANDBOX_ENV_STORAGE_KEY) ?? {};
    const merged = { ...stored };
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    this.ctx.storage.kv.put(SANDBOX_ENV_STORAGE_KEY, merged);
    this.#emitLifecycleEvent({
      type: "events.iterate.com/sandbox/configured",
      payload: { env: definedEnvEntries(vars) ?? {} },
    });
    await this.#redialOnInterruptedSessionSetup(() => super.setEnvVars(vars)).catch(
      (error: unknown) =>
        console.warn("sandbox setEnvVars: applying to running container failed", error),
    );
  }

  async #applyStoredEnvVars(): Promise<void> {
    // Discovered connections first, explicit config last — so a project with
    // a GitHub connection gets a working GH_TOKEN with no setup, while
    // setEnvVars still wins for anything it sets.
    const stored = this.ctx.storage.kv.get<SandboxEnvVars>(SANDBOX_ENV_STORAGE_KEY) ?? {};
    const discovered = await this.#discoverGithubTokenEnv();
    // Redial like every command: setEnvVars is idempotent, and during a cold
    // boot its session dial is as exposed to client churn as any exec.
    await this.#redialOnInterruptedSessionSetup(() =>
      super.setEnvVars({ ...discovered, ...stored }),
    );
  }

  /**
   * `GH_TOKEN` for the project's GitHub connection, when one exists — a
   * `getSecret` placeholder (see {@link githubTokenEnvForConnections}), never
   * token bytes, so `gh` and git-over-https work against github.com out of
   * the box. Computed fresh per container start rather than stored: a
   * connection made after this container booted is picked up on the next
   * start, and a disconnected one stops being planted the same way.
   * Failure-tolerant by design — discovery dials the project processor, and a
   * hiccup there must never block provisioning (log, start without GH_TOKEN,
   * the next container start retries).
   */
  async #discoverGithubTokenEnv(): Promise<SandboxEnvVars> {
    try {
      const connections = await listIntegrationConnections(this.#identity().projectId);
      const placeholder = githubTokenEnvForConnections(connections);
      return placeholder === null ? {} : { GH_TOKEN: placeholder };
    } catch (error) {
      console.warn("sandbox GH_TOKEN discovery failed; starting without it", error);
      return {};
    }
  }

  /**
   * Plant stock git identity + (when `GH_TOKEN` is set) github.com HTTPS auth.
   * See {@link SANDBOX_GIT_CONFIG_SHELL}. Identity always; auth only with a
   * GitHub connection. Ephemeral disk → re-run per container start.
   * Best-effort: a hiccup must not fail provisioning.
   */
  async #configureGit(): Promise<void> {
    try {
      await this.#redialOnInterruptedSessionSetup(() => super.exec(SANDBOX_GIT_CONFIG_SHELL));
    } catch (error) {
      console.warn("sandbox git configuration failed; commits/git-over-https may misbehave", error);
    }
  }

  // ---------------------------------------------------------------------------
  // The existence + workspace guarantee, enforced: every public command and
  // file operation below awaits `#ensureReady()` before touching the
  // container, so (a) a never-created or destroyed sandbox refuses every
  // command, and (b) no caller can observe `/workspace` before the newest
  // snapshot was restored into the current container — which also closes an
  // integrity window: a write landing before the restore would be silently
  // clobbered BY the restore.
  //
  // Notes for maintainers:
  // - These are real prototype methods, not `field = () => …` — instance
  //   fields are invisible over workers RPC, and callers hold this class's
  //   bare stub.
  // - Provisioning itself must call `super.*` (it runs INSIDE the guard;
  //   `this.*` would deadlock on its own promise). The SDK's backup/restore
  //   internals use their own private exec paths and are unaffected.
  // - Session objects are covered via guarded `createSession`; the SDK's
  //   session wrappers route their file ops back through these methods.
  // - New SDK methods start unguarded — add workspace-touching ones here.
  // ---------------------------------------------------------------------------

  async #ensureReady(): Promise<void> {
    this.#assertUsable();
    await this.#ensureWorkspaceCurrent();
  }

  /**
   * Re-dial when the SDK's per-command session SETUP was interrupted.
   *
   * Every command runner first dials `utils.createSession` on the container;
   * a container-client replacement mid-dial — boot churn on a cold container,
   * or a container transition racing the call — surfaces as
   * OPERATION_INTERRUPTED / transport_disposed on that setup call (observed
   * repeatedly in preview e2e and CI). The SDK marks it `retryable: false`
   * because it can't know whether the COMMAND ran — but when the interrupted
   * operation is the session setup itself, the command was never admitted, so
   * a bounded re-dial is provably safe. Scoped to exactly that case: a
   * `commands.execute` interruption still throws (the command may have run).
   * Done here at dispatch so every caller — agents, the REPL, e2e — inherits
   * the resilience instead of each inventing its own retry.
   */
  async #redialOnInterruptedSessionSetup<T>(call: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await call();
      } catch (error) {
        const delayMs = SANDBOX_SESSION_SETUP_REDIAL_DELAYS_MS[attempt];
        if (!isInterruptedSessionSetup(error) || delayMs === undefined) throw error;
        attempt += 1;
        console.warn(
          "sandbox session dial interrupted mid-setup; re-dialing",
          { attempt, delayMs },
          error,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Execute a timed command through the SDK's sessionless STREAM door so the
   * start event gives us the real detached process-group leader. The stock
   * 0.12.3 timeout watches only that leader: if TERM kills the leader while a
   * child ignores it, the SDK can return 124 with the child still running (or
   * wait forever while that child holds an output pipe). We therefore own the
   * deadline, verify the entire group with `ps`, escalate TERM to KILL, and
   * synthesize 124 only after cleanup and stream drain both finish.
   */
  async #execSessionlessWithVerifiedTimeout(
    command: string,
    options: ExecOptions & { timeout: number },
  ): Promise<ExecResult> {
    const timeoutMs = options.timeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error(`Sandbox exec timeout must be between 1 and 2147483647ms: ${timeoutMs}`);
    }
    if (options.signal?.aborted === true) throw new Error("Operation was aborted");

    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    const timestamp = new Date(startedAt).toISOString();
    const stream = await this.#redialOnInterruptedSessionSetup(() =>
      super.execStreamWithSessionToken(command, SANDBOX_SESSIONLESS_EXECUTION_TOKEN, {
        cwd: options.cwd,
        env: options.env,
      }),
    );

    let stdout = "";
    let stderr = "";
    let sawStart = false;
    let resolveStarted!: (pid: number) => void;
    let rejectStarted!: (error: unknown) => void;
    const started = new Promise<number>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const completion = (async (): Promise<number> => {
      try {
        for await (const event of parseSSEStream<ExecEvent>(stream)) {
          switch (event.type) {
            case "start": {
              if (sawStart)
                throw new Error("Sandbox exec stream emitted more than one start event");
              if (!Number.isSafeInteger(event.pid) || (event.pid ?? 0) <= 1) {
                throw new Error(
                  `Sandbox exec stream emitted an invalid process-group id: ${String(event.pid)}`,
                );
              }
              sawStart = true;
              resolveStarted(event.pid!);
              break;
            }
            case "stdout":
            case "stderr": {
              const data = event.data ?? "";
              if (event.type === "stdout") stdout += data;
              else stderr += data;
              if (options.stream === true) options.onOutput?.(event.type, data);
              break;
            }
            case "complete": {
              const exitCode = event.exitCode ?? event.result?.exitCode;
              if (!Number.isInteger(exitCode)) {
                throw new Error("Sandbox exec stream completed without an exit code");
              }
              return exitCode!;
            }
            case "error":
              throw new Error(event.error ?? "Sandbox exec stream failed without an error message");
          }
        }
        throw new Error("Sandbox exec stream ended without a completion event");
      } catch (error) {
        if (!sawStart) rejectStarted(error);
        throw error;
      }
    })();

    const processGroupId = await Promise.race([
      started,
      completion.then(() => {
        throw new Error("Sandbox exec stream completed before its start event");
      }),
    ]);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      // Session setup and delivery of the start event consume the caller's
      // budget too. We still wait for the start event before enforcing an
      // expired deadline because it is the only safe way to learn which
      // process group must be terminated.
      timeoutId = setTimeout(
        () => resolve({ kind: "timeout" }),
        Math.max(0, deadlineAt - Date.now()),
      );
    });
    const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
      if (options.signal === undefined) return;
      abortListener = () => resolve({ kind: "aborted" });
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    });

    let outcome:
      | { exitCode: number; kind: "completed" }
      | { kind: "timeout" }
      | { kind: "aborted" };
    try {
      outcome = await Promise.race([
        completion.then((exitCode) => ({ exitCode, kind: "completed" }) as const),
        timeout,
        aborted,
      ]);
    } catch (error) {
      try {
        await this.#terminateSandboxProcessGroup(processGroupId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Sandbox exec stream failed and process-group ${processGroupId} cleanup also failed`,
        );
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
    }

    if (outcome.kind === "completed") {
      const result: ExecResult = {
        command,
        duration: Date.now() - startedAt,
        exitCode: outcome.exitCode,
        stderr,
        stdout,
        success: outcome.exitCode === 0,
        timestamp,
      };
      options.onComplete?.(result);
      return result;
    }

    await this.#terminateSandboxProcessGroup(processGroupId);
    await this.#waitForTerminatedSandboxStream(completion, processGroupId);

    if (outcome.kind === "aborted") throw new Error("Operation was aborted");

    const result: ExecResult = {
      command,
      duration: Date.now() - startedAt,
      exitCode: SANDBOX_TIMEOUT_EXIT_CODE,
      stderr: appendSandboxTimeoutMessage(stderr, timeoutMs),
      stdout,
      success: false,
      timestamp,
    };
    options.onComplete?.(result);
    return result;
  }

  async #terminateSandboxProcessGroup(processGroupId: number): Promise<void> {
    const cleanup = await this.#redialOnInterruptedSessionSetup(() =>
      super.execWithSessionToken(
        sandboxProcessGroupCleanupCommand(processGroupId),
        SANDBOX_SESSIONLESS_EXECUTION_TOKEN,
        { origin: "internal", timeout: SANDBOX_PROCESS_GROUP_CLEANUP_TIMEOUT_MS },
      ),
    );
    if (cleanup.exitCode === 0) return;
    throw new Error(
      `Sandbox process-group ${processGroupId} cleanup failed with exit ${cleanup.exitCode}: ${cleanup.stderr || cleanup.stdout}`,
    );
  }

  async #waitForTerminatedSandboxStream(
    completion: Promise<number>,
    processGroupId: number,
  ): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () =>
              reject(
                new Error(
                  `Sandbox process-group ${processGroupId} was terminated but its exec stream did not settle`,
                ),
              ),
            SANDBOX_TERMINATED_STREAM_DRAIN_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  override async exec(...args: Parameters<Sandbox<Env>["exec"]>) {
    await this.#ensureReady();
    const [command, options] = args;
    if (options?.timeout !== undefined) {
      try {
        return await this.#execSessionlessWithVerifiedTimeout(command, {
          ...options,
          timeout: options.timeout,
        });
      } catch (error) {
        if (error instanceof Error) options.onError?.(error);
        throw error;
      }
    }
    return this.#redialOnInterruptedSessionSetup(() =>
      super.execWithSessionToken(command, SANDBOX_SESSIONLESS_EXECUTION_TOKEN, options),
    );
  }

  override async execStream(...args: Parameters<Sandbox<Env>["execStream"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.execStream(...args));
  }

  override async startProcess(...args: Parameters<Sandbox<Env>["startProcess"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.startProcess(...args));
  }

  override async createSession(...args: Parameters<Sandbox<Env>["createSession"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.createSession(...args));
  }

  override async runCode(...args: Parameters<Sandbox<Env>["runCode"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.runCode(...args));
  }

  override async runCodeStream(...args: Parameters<Sandbox<Env>["runCodeStream"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.runCodeStream(...args));
  }

  override async gitCheckout(...args: Parameters<Sandbox<Env>["gitCheckout"]>) {
    await this.#ensureReady();
    return this.#redialOnInterruptedSessionSetup(() => super.gitCheckout(...args));
  }

  override async mkdir(...args: Parameters<Sandbox<Env>["mkdir"]>) {
    await this.#ensureReady();
    return super.mkdir(...args);
  }

  override async writeFile(...args: Parameters<Sandbox<Env>["writeFile"]>) {
    await this.#ensureReady();
    return super.writeFile(...args);
  }

  override async deleteFile(...args: Parameters<Sandbox<Env>["deleteFile"]>) {
    await this.#ensureReady();
    return super.deleteFile(...args);
  }

  override async renameFile(...args: Parameters<Sandbox<Env>["renameFile"]>) {
    await this.#ensureReady();
    return super.renameFile(...args);
  }

  override async moveFile(...args: Parameters<Sandbox<Env>["moveFile"]>) {
    await this.#ensureReady();
    return super.moveFile(...args);
  }

  // `readFile` is overloaded (encoding "none" returns a stream result vs the
  // default read result), and neither result type is exported. Restate both
  // overloads with return types recovered from the base's own signature (via
  // {@link ReadFileReturns}) — no mirrored interfaces to drift, still a
  // prototype method (a `field = () => …` would be invisible over RPC).
  override readFile(
    path: string,
    options: { encoding: "none"; sessionId?: string },
  ): ReadFileReturns["stream"];
  override readFile(
    path: string,
    options?: { encoding?: "utf8" | "utf-8" | "base64"; sessionId?: string },
  ): ReadFileReturns["buffered"];
  // Permissive implementation signature (hidden from callers — the two typed
  // overloads above are the public contract); the standard shape for
  // implementing an overloaded method.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- overloaded impl signature
  override async readFile(path: string, options?: any): Promise<any> {
    await this.#ensureReady();
    return super.readFile(path, options);
  }

  override async readFileStream(...args: Parameters<Sandbox<Env>["readFileStream"]>) {
    await this.#ensureReady();
    return super.readFileStream(...args);
  }

  override async listFiles(...args: Parameters<Sandbox<Env>["listFiles"]>) {
    await this.#ensureReady();
    return super.listFiles(...args);
  }

  override async exists(...args: Parameters<Sandbox<Env>["exists"]>) {
    await this.#ensureReady();
    return super.exists(...args);
  }

  override async watch(...args: Parameters<Sandbox<Env>["watch"]>) {
    await this.#ensureReady();
    return super.watch(...args);
  }

  override async checkChanges(...args: Parameters<Sandbox<Env>["checkChanges"]>) {
    await this.#ensureReady();
    return super.checkChanges(...args);
  }

  #ensureWorkspace(): Promise<void> {
    if (this.#workspaceReady !== undefined) return this.#workspaceReady;
    // `run` is only read inside the closures below, which execute strictly
    // after the assignment at the bottom (the first read sits behind two
    // awaits) — initialized to undefined so TS's definite-assignment analysis
    // doesn't have to prove that ordering.
    let run: Promise<void> | undefined = undefined;
    // Whether this run is still the registered one. False the moment a
    // container restart resets `#workspaceReady` (onStart) or a newer run
    // replaces it — a stale run's work landed on the OLD container's disk.
    const isCurrent = () => this.#workspaceReady === run;
    run = (async () => {
      const restoredBackupId = await this.#restoreWorkspace();
      // Re-apply the durable env map onto THIS container (the SDK does not
      // document env persistence across restart), so every guarded command
      // below runs with the configured vars.
      await this.#applyStoredEnvVars();
      await this.#configureGit();
      // A container restart mid-run reset the state for a NEW, empty disk —
      // everything this run did landed on the old one. Only the still-current
      // run may mark the workspace provisioned: a stale run setting the flag
      // would let the idle backup snapshot a half-provisioned /workspace over
      // the last good backup.
      if (!isCurrent()) return;
      // Report only now that the workspace is whole and this run still owns
      // the container: an event emitted mid-provisioning would tell consumers
      // the files are back while the restore is still running.
      if (restoredBackupId !== null) {
        this.#emitLifecycleEvent({
          type: "events.iterate.com/sandbox/workspace-restored",
          payload: { backupId: restoredBackupId },
        });
      }
      this.#workspaceProvisioned = true;
    })().catch((error: unknown) => {
      // A stale run's failure is not this container's story: the newer run
      // owns the events and the memo. Resolve quietly — the guard loop in
      // #ensureWorkspaceCurrent re-enters and picks up the current run.
      if (!isCurrent()) return;
      console.error("sandbox workspace setup failed", error);
      // Let the next ensure retry instead of caching the failure forever.
      this.#workspaceReady = undefined;
      throw error;
    });
    this.#workspaceReady = run;
    return run;
  }

  /**
   * FENCE: `mountBucket` is known-broken under our egress model — its
   * R2-binding mode routes s3fs traffic to the magic host `r2.internal`,
   * serviced by the SDK's own per-host egress interceptor, which the
   * catch-all project-egress handler necessarily swallows (verified live:
   * every filesystem op on the mount returned I/O errors). A method that
   * silently breaks a platform invariant is worse than a clean refusal.
   */
  override async mountBucket(..._args: Parameters<Sandbox<Env>["mountBucket"]>): Promise<never> {
    throw new Error(
      "mountBucket is unavailable on iterate sandboxes (its r2.internal traffic cannot " +
        "coexist with project-egress interception). /workspace already persists across " +
        "sleep via snapshots — keep durable files there.",
    );
  }

  /**
   * FENCE: `exposePort` preview URLs route by a sandbox-ID hostname, and our
   * Durable Object names (`{projectId}.iterate/sandboxes/...`) are never
   * hostname-safe — the URLs are dead on arrival. Cloudflare deprecated the
   * API in favor of tunnels anyway; refuse loudly instead of minting a URL
   * that can never resolve.
   */
  override async exposePort(..._args: Parameters<Sandbox<Env>["exposePort"]>): Promise<never> {
    throw new Error(
      "exposePort is unavailable on iterate sandboxes (preview URLs cannot route to " +
        "path-addressed sandboxes). Use tunnels instead: `await sandbox.tunnels.get(port)` " +
        "returns a public https://<random>.trycloudflare.com url.",
    );
  }

  /**
   * Append a lifecycle event to the stream at this sandbox's own path, so
   * anyone tailing the stream sees the whole saga — commands
   * (`*-requested`), completions (`created`/`started`/`stopped`/`destroyed`),
   * snapshots and restores — as ordinary history, and every sandbox in a
   * project is discoverable as a stream under `/sandboxes/`. The event
   * catalog is the sandbox processor contract
   * (sandbox-processor-contract.ts); building through it keeps emission and
   * declaration from drifting. This fire-and-forget lane is reserved for
   * ancillary audit events. Lifecycle completions that drive `running` await
   * their durable append and either wait for the fold at an ordinary command
   * boundary or schedule it outside the SDK lifecycle callback.
   */
  #emitLifecycleEvent(input: SandboxLifecycleEventInput): void {
    try {
      this.ctx.waitUntil(
        this.#appendLifecycleEvent(input).catch((error: unknown) =>
          console.warn(`sandbox lifecycle event append failed (${input.type})`, error),
        ),
      );
    } catch (error) {
      console.warn(`sandbox lifecycle event skipped (${input.type})`, error);
    }
  }

  async #appendLifecycleEvent(input: SandboxLifecycleEventInput): Promise<number> {
    const event = SandboxProcessorContract.buildEvent(input);
    const [appended] = await this.#processorResources().registry.stream.append(event);
    if (appended === undefined) {
      throw new Error(`sandbox lifecycle append returned no event (${input.type})`);
    }
    return appended.offset;
  }

  async #appendBirth(instanceType: SandboxInstanceType): Promise<void> {
    const identity = this.#identity();
    const durableObjectName = DurableObjectNameCodec.stringify(identity);
    const { registry } = this.#processorResources();
    const [created, configured] = await registry.stream.append(
      SandboxProcessorContract.buildEvent({
        type: "events.iterate.com/sandbox/created",
        idempotencyKey: `sandbox/created:${durableObjectName}`,
        payload: { config: { instanceType } },
      }),
      buildDurableObjectProcessorSubscriptionConfiguredEvent({
        durableObjectName,
        idempotencyKey: `stream/subscription-configured:${durableObjectName}#${SandboxProcessorContract.slug}`,
        processor: ["sandboxes", ["processor", identity.path]],
        processorSlug: SandboxProcessorContract.slug,
      }),
    );
    if (created === undefined || configured === undefined) {
      throw new Error(`sandbox "${identity.path}": birth append returned no event`);
    }
    await this.#waitUntilProcessed(Math.max(created.offset, configured.offset));
  }

  async #appendLifecycleEventAndWait(input: SandboxLifecycleEventInput): Promise<void> {
    await this.#waitUntilProcessed(await this.#appendLifecycleEvent(input));
  }

  /** SDK onStart/onStop run inside the container framework's
   * blockConcurrencyWhile budget. Make the completion durable before the hook
   * returns, then let push delivery/catch-up advance reduced state without
   * spending that lifecycle budget waiting on another Durable Object. */
  async #appendLifecycleEventAndCatchUpInBackground(
    input: SandboxLifecycleEventInput,
  ): Promise<number> {
    const offset = await this.#appendLifecycleEvent(input);
    this.ctx.waitUntil(this.#waitUntilProcessed(offset));
    return offset;
  }

  /** Fold the latest completion before an explicit lifecycle command
   * returns. An undefined offset means this command found the container
   * already in the requested condition; catchUp still closes any reducer lag
   * left by an earlier incarnation's durable lifecycle append. */
  async #catchUpLifecycleCompletion(offset: number | undefined): Promise<void> {
    if (offset === undefined) {
      await this.#processorResources().registry.catchUp(SandboxProcessorContract.slug);
      return;
    }
    await this.#waitUntilProcessed(offset);
  }

  async #waitUntilProcessed(offset: number): Promise<void> {
    const { reads, registry } = this.#processorResources();
    await registry.catchUp(SandboxProcessorContract.slug);
    await reads.waitUntilEvent({ offset, timeoutMs: SANDBOX_PROCESSOR_WAIT_TIMEOUT_MS });
  }
}

// ---------------------------------------------------------------------------
// One concrete class per instance type. Cloudflare fixes the container
// instance type PER CLASS in wrangler config (see instance-types.ts and
// scripts/generate-wrangler-config.ts), so "sandboxes of different sizes"
// means one container class per instance type, all sharing the implementation
// above. Class names must match SANDBOX_INSTANCE_TYPE_BINDINGS
// (instance-types.ts) — that table is what wrangler config generation and the
// collection's routing read.
//
// Each subclass registers its own egress handler: the containers SDK keys
// its outbound registry by class name, and instances look handlers up under
// `this.constructor.name` — see the note on {@link sandboxOutboundFor}
// for why these are static BLOCKS, not `static outbound = …` fields.
// ---------------------------------------------------------------------------

export class SandboxLiteDurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "lite";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}

export class SandboxBasicDurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "basic";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}

export class SandboxStandard1DurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "standard-1";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}

export class SandboxStandard2DurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "standard-2";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}

export class SandboxStandard3DurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "standard-3";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}

export class SandboxStandard4DurableObject extends SandboxDurableObject {
  protected static override sandboxInstanceType: SandboxInstanceType = "standard-4";
  static {
    this.outbound = sandboxOutboundFor(this.sandboxInstanceType);
  }
}
