import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { HostedStreamMethod } from "./hosted-stream-routing.ts";
import { HOSTED_STREAM_HOST_PATH, isHostedStreamPrototypePath } from "./hosted-stream-routing.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

type HostedAlarmHost = {
  deleteHostedStreamAlarm(input: { logicalName: string }): Promise<void>;
  getHostedStreamAlarm(input: { logicalName: string }): Promise<number | null>;
  setHostedStreamAlarm(input: { atMs: number; logicalName: string }): Promise<void>;
};

/**
 * Cross-DO alarm writes do not participate in a child's native output gate.
 * The hosted method and alarm RPCs drain each required arm before they reply.
 * Redundant clears are coalesced after a confirmed empty host record, so PCM
 * batches do not acquire a per-frame parent write or round trip.
 */
export class HostedAlarmRelay {
  readonly #host: HostedAlarmHost;
  readonly #logicalName: string;
  #tail: Promise<void> = Promise.resolve();
  #failure: { error: unknown; setVersion: number } | undefined;
  #hostAlarmKnownEmpty = false;
  #intentVersion = 0;
  #lastConfirmedSetVersion = 0;
  #lastIntentWasDelete = false;
  #lastDelete: Promise<void> | undefined;

  constructor(host: HostedAlarmHost, logicalName: string) {
    this.#host = host;
    this.#logicalName = logicalName;
  }

  setAlarm(atMs: number): Promise<void> {
    const setVersion = ++this.#intentVersion;
    this.#hostAlarmKnownEmpty = false;
    this.#lastIntentWasDelete = false;
    return this.#enqueue(async () => {
      try {
        await this.#host.setHostedStreamAlarm({ atMs, logicalName: this.#logicalName });
        this.#lastConfirmedSetVersion = setVersion;
        if ((this.#failure?.setVersion ?? -1) <= setVersion) this.#failure = undefined;
      } catch (error) {
        // Serialization means a later desired parent write cannot be overtaken
        // by this failure. Keep only a failure newer than the last confirmed set.
        if (setVersion > this.#lastConfirmedSetVersion) this.#failure = { error, setVersion };
      }
    });
  }

  deleteAlarm(): Promise<void> {
    // A quiet all-ephemeral PCM suffix reaches clearWhenQuiet repeatedly. One
    // queued parent delete is enough until a later arm changes that intent.
    if (this.#hostAlarmKnownEmpty || this.#lastIntentWasDelete) {
      return this.#lastDelete ?? Promise.resolve();
    }
    const deleteVersion = ++this.#intentVersion;
    this.#lastIntentWasDelete = true;
    const deletion = this.#enqueue(async () => {
      try {
        await this.#host.deleteHostedStreamAlarm({ logicalName: this.#logicalName });
        if (this.#intentVersion === deleteVersion) this.#hostAlarmKnownEmpty = true;
      } catch (error) {
        // A rejected delete leaves the old parent record in place: an observable
        // extra wake, never a lost wake. Do not make PCM clears wait on it.
        console.error("hosted stream alarm disarm failed; retained host wake", {
          error,
          logicalName: this.#logicalName,
        });
      }
    });
    this.#lastDelete = deletion;
    return deletion;
  }

  getAlarm(): Promise<number | null> {
    return this.#host.getHostedStreamAlarm({ logicalName: this.#logicalName });
  }

  get hasFailedRequiredArm(): boolean {
    return this.#failure !== undefined;
  }

  /** One caller-triggered recovery attempt after a failed required arm. The
   * duplicate append path may have no new events to reconcile, so it cannot
   * rely on StreamDO to schedule this replacement itself. */
  repairFailedArm(atMs: number): Promise<void> {
    const failure = this.#failure;
    if (!failure) throw new Error("hosted alarm repair requested without failure");
    // Concurrent duplicate retries share a repair already queued after this
    // failure. A later clear is different intent and receives its own set.
    if (this.#intentVersion > failure.setVersion && !this.#lastIntentWasDelete) return this.#tail;
    return this.setAlarm(atMs);
  }

  async flushRequiredWrites(): Promise<void> {
    // Keep a failed arm visible until a newer arm commits. Clearing it when
    // this promise rejects would let another sender pass before the first
    // sender's catch resets its coalesced alarm marker.
    await this.#tail;
    if (this.#failure) {
      throw new Error("hosted stream alarm write failed", { cause: this.#failure.error });
    }
  }

  #enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(work);
    // Continue the per-child chain after a rejected host call. `work` catches
    // expected relay failures, but this keeps an unexpected implementation
    // defect observable to its caller without stranding every later intent.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * A real StreamDurableObject running in one child facet. The proxy supplies
 * its logical name and relays only the three native-alarm storage operations
 * to the warm parent. SQLite/KV, WebSockets, facets, and all StreamDO logic
 * remain this child's own state and implementation.
 */
export class HostedStreamPrototypeFacet extends StreamDurableObject {
  readonly #relay: HostedAlarmRelay;

  constructor(ctx: DurableObjectState, env: Env) {
    const logicalName = readFacetLogicalName(ctx, env);
    const logical = DurableObjectNameCodec.parse(logicalName, { allowNullProjectId: true });
    if (!logical.projectId) throw new Error("hosted stream prototype requires a project id");
    // This is the child Durable Object's own parent-alarm relay; it is not ingress.
    // This same-project StreamDO is the dedicated host. The binding type
    // cannot express its small hosted-alarm RPC surface, so narrow it here.
    // oxlint-disable-next-line iterate/no-raw-durable-object-binding-access
    const host = env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        path: HOSTED_STREAM_HOST_PATH,
        projectId: logical.projectId,
      }),
    ) as unknown as HostedAlarmHost;
    const relay = new HostedAlarmRelay(host, logicalName);
    super(ctx, env, hostedStreamContext(ctx, relay, logicalName));
    this.#relay = relay;
  }

  async invokeHostedStream(input: {
    args: unknown[];
    method: HostedStreamMethod;
  }): Promise<unknown> {
    // The parent validates HostedStreamMethod. This cast avoids duplicating
    // that protocol list solely to add this hosted-alarm acknowledgement gate.
    const method = this[input.method] as unknown;
    if (typeof method !== "function") {
      throw new Error(`hosted stream prototype does not implement ${input.method}`);
    }
    return await this.#atHostedBoundary(() => Reflect.apply(method, this, input.args));
  }

  /** `alarm` is a platform callback name, not a cross-facet RPC contract. */
  async handleHostedAlarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#atHostedBoundary(() => this.alarm(alarmInfo));
  }

  override async fetch(request: Request): Promise<Response> {
    return await this.#atHostedBoundary(() => super.fetch(request));
  }

  override async webSocketClose(webSocket: WebSocket): Promise<void> {
    await this.#atHostedBoundary(() => super.webSocketClose(webSocket));
  }

  async #atHostedBoundary<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      // A duplicate idempotency-key append can return before StreamDO's normal
      // reconciliation runs. Repair one previously failed hosted arm first;
      // healthy microphone frames issue no await, RPC, or durable write here.
      if (this.#relay.hasFailedRequiredArm) await this.#relay.repairFailedArm(Date.now());
      const value = await work();
      await this.#relay.flushRequiredWrites();
      return value;
    } catch (error) {
      this.forgetHostedAlarmWriteFailure();
      throw error;
    }
  }
}

function readFacetLogicalName(ctx: DurableObjectState, env: Env): string {
  if (env.DEPLOYMENT_ENV !== "preview_17") {
    throw new Error("hosted stream prototype is only enabled in preview_17");
  }
  if (typeof ctx.id !== "string") {
    throw new Error("hosted stream prototype facet requires its string logical id");
  }
  const logical = DurableObjectNameCodec.parse(ctx.id, { allowNullProjectId: true });
  if (!isHostedStreamPrototypePath(logical.path)) {
    throw new Error(`hosted stream prototype rejects ${logical.path}`);
  }
  return ctx.id;
}

function hostedStreamContext(
  ctx: DurableObjectState,
  relay: HostedAlarmRelay,
  logicalName: string,
): DurableObjectState {
  const storage = new Proxy(ctx.storage, {
    get(target, property) {
      if (property === "setAlarm") return (atMs: number) => relay.setAlarm(atMs);
      if (property === "getAlarm") return () => relay.getAlarm();
      if (property === "deleteAlarm") return () => relay.deleteAlarm();
      if (property === "awaitHostedAlarmWrites") return () => relay.flushRequiredWrites();
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The proxy preserves every native context member except the child logical
  // id and the three alarm operations, which must relay through the host.
  // Proxy typing cannot retain DurableObjectState's branded platform shape;
  // its traps below preserve that shape at runtime.
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "id") return { name: logicalName };
      if (property === "storage") return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DurableObjectState;
}
