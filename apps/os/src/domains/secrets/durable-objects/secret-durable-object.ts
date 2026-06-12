// The Secret Durable Object: one per Secret, folding `/secrets/{slug}` in the
// owning project's namespace.
//
// The design constraint everything here serves: MATERIAL NEVER LEAVES THE DO
// in the normal path. Callers either ask the DO to perform a fetch with
// `{{secret}}` placeholders substituted (fetchWithSecret), or — for
// platform-trusted consumers that genuinely need bytes in hand (websocket
// identify frames, SDK constructors inside first-party loopbacks) — call the
// audited revealForPlatformUse trapdoor. Both paths append a `secret/used`
// audit event to the journal.
//
// The LOGIC lives in the secret PROCESSOR (stream-processors/secret), not
// here: derivation runs are its reaction to `secret/derive-requested` events.
// This DO is the processor's host and nothing more clever — it supplies the
// capabilities only it has (the deployment encryption key, sibling-secret
// dials), arms the expiry alarm the processor asks for, and exposes
// request/response verbs that only APPEND FACTS AND READ THE FOLD: a stale
// use appends derive-requested and waits for the fold to advance; the alarm
// appends the same event. Concurrent stale uses dedupe to one derivation run
// (version-keyed idempotency + the processor's fold gate).

import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { getInitializedDoStub } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
import {
  ensureStartedOrInitializeFromRuntimeName,
  waitForProcessorCatchUp,
} from "~/domains/streams/stream-processor-do-helpers.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";
import {
  decryptSecretMaterial,
  encryptSecretMaterial,
  importSecretsKey,
} from "~/domains/secrets/secret-crypto.ts";
import { materialIsStale } from "~/domains/secrets/secret-derivation.ts";
import { secretStreamPath } from "~/domains/secrets/stream-processors/secret/contract.ts";
import {
  SecretProcessor,
  SecretProcessorContract,
} from "~/domains/secrets/stream-processors/secret/implementation.ts";
import { getSecretDurableObjectName } from "~/domains/secrets/secret-naming.ts";
import {
  substituteSecretPlaceholders,
  type SubstitutableRequest,
} from "~/domains/secrets/secret-substitution.ts";

export { getSecretDurableObjectName };

const SecretDurableObjectStructuredName = z.object({
  projectId: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});
export type SecretDurableObjectStructuredName = z.infer<typeof SecretDurableObjectStructuredName>;

/** Mint a Secret DO stub from a trusted domain file (see lint rule). Plain
 * getByName: the DO adopts its runtime name on first wake. */
export function getSecretStub(input: SecretDurableObjectStructuredName) {
  return (env as unknown as SecretDurableObjectEnv).SECRET.getByName(
    getSecretDurableObjectName(input),
  );
}

/** As above, but through the lifecycle initialize path (creates the catalog
 * record) — for write/setup flows. */
export async function ensureSecretStub(input: SecretDurableObjectStructuredName) {
  return await getInitializedDoStub({
    allowCreate: true,
    name: input,
    namespace: (env as unknown as SecretDurableObjectEnv).SECRET,
  });
}

type SecretDurableObjectEnv = {
  DO_CATALOG: D1Database;
  SECRET: DurableObjectNamespace<SecretDurableObject>;
  SECRETS_ENCRYPTION_KEY?: string;
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

const SecretLifecycleBase = createIterateDurableObjectBase<
  typeof SecretDurableObjectStructuredName,
  Pick<SecretDurableObjectEnv, "DO_CATALOG">
>({
  className: "SecretDurableObject",
  getDatabase: (env) => env.DO_CATALOG,
  indexes: {
    projectId: (params) => params.projectId,
  },
  nameSchema: SecretDurableObjectStructuredName,
});

const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = "events.iterate.com/stream/subscription-configured";

type SecretState = Awaited<ReturnType<SecretProcessor["snapshot"]>>["state"];

export class SecretDurableObject extends SecretLifecycleBase<SecretDurableObjectEnv> {
  host = createStreamProcessorHost(this.ctx);
  secret = this.host.add(SecretProcessorContract.slug, (deps) => {
    return new SecretProcessor({
      ...deps,
      onRefreshableMaterial: ({ expiresAt, refreshLeewaySeconds }) => {
        const refreshAtMs = Date.parse(expiresAt) - refreshLeewaySeconds * 1000;
        if (!Number.isFinite(refreshAtMs)) return;
        void this.ctx.storage.setAlarm(Math.max(refreshAtMs, Date.now() + 1000));
      },
      // The two capabilities only the host has: the deployment key, and
      // dials on sibling Secret DOs (derivation sources resolve through
      // their own domain objects, freshness included).
      encryptMaterial: async (material) =>
        await encryptSecretMaterial({ key: await this.encryptionKey(), material }),
      resolveSecretKey: async (key) => {
        const params = await this.ensureParams();
        return await getSecretStub({ projectId: params.projectId, slug: key }).revealForPlatformUse(
          { usedBy: `secret:${params.slug}:derivation` },
        );
      },
    });
  });

  constructor(ctx: DurableObjectState, env: SecretDurableObjectEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureSecretSubscription(params);
    });
  }

  /** Closure-bridged because the lifecycle mixin's getDurableObjectName is protected. */
  private ensureParams() {
    return ensureStartedOrInitializeFromRuntimeName({
      ensureStarted: () => this.ensureStarted(),
      getDurableObjectName: () => this.getDurableObjectName(),
      initialize: (input) => this.initialize(input),
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureParams();
    return await this.host.requestStreamSubscription(args);
  }

  /** Public view of the Secret: material-free — except plain config
   * variables (sensitivity: "plain"), whose value is included. */
  async describe() {
    const { state } = await this.readyState();
    const { encryptedMaterial, derivation, ...visible } = state;
    return {
      ...visible,
      hasMaterial: encryptedMaterial != null,
      derivation: derivation == null ? null : { kind: derivation.kind },
      ...(state.sensitivity === "plain" && encryptedMaterial != null
        ? {
            value: await decryptSecretMaterial({
              key: await this.encryptionKey(),
              encrypted: encryptedMaterial,
            }),
          }
        : {}),
    };
  }

  /**
   * Perform an HTTP request with `{{secret}}` placeholders (url, header
   * values, string body) replaced by the material — re-derived first if
   * stale. The substituted request and live response exist only inside this
   * DO; the caller gets a serializable response snapshot. Every call appends
   * a `secret/used` audit event.
   */
  async fetchWithSecret(input: { request: SubstitutableRequest; usedBy: string }) {
    const { params, state } = await this.readyState();
    const material = await this.ensureFreshMaterial({ params, state });
    const substituted = substituteSecretPlaceholders(input.request, material);
    const response = await fetch(substituted.url, {
      method: substituted.method ?? "GET",
      headers: substituted.headers,
      ...(substituted.body == null ? {} : { body: substituted.body }),
    });
    const body = await response.text();
    await this.appendUsedEvent({
      params,
      usage: "fetch",
      usedBy: input.usedBy,
      urlHost: new URL(substituted.url).hostname,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }

  /**
   * The audited trapdoor for PLATFORM-TRUSTED consumers only: first-party
   * loopback capabilities constructing SDK clients, the Discord gateway
   * building its identify frame, and sibling Secret DOs resolving derivation
   * sources. Project worker code and agents never get a dial on this — they
   * go through fetchWithSecret or egress substitution.
   */
  async revealForPlatformUse(input: { usedBy: string }) {
    const { params, state } = await this.readyState();
    const material = await this.ensureFreshMaterial({ params, state });
    await this.appendUsedEvent({ params, usage: "reveal", usedBy: input.usedBy });
    return material;
  }

  /** The clock half of refresh: the alarm only appends the request fact;
   * the processor reacts. */
  async alarm() {
    const { params, state } = await this.readyState();
    if (state.status !== "set" || state.derivation == null) return;
    await this.appendDeriveRequested({ params, state, reason: "alarm-refresh" });
  }

  async ensureReady() {
    const params = await this.ensureParams();
    await this.ensureSecretSubscription(params);
    await this.waitForCatchUp(params);
    return await this.secret.snapshot();
  }

  /** Stale material + a derivation = append `secret/derive-requested` and
   * wait for the PROCESSOR's reaction to fold — this verb never derives
   * itself. The request is idempotency-keyed by the stale version, so the
   * very use that found it stale, a concurrent use, and the alarm all
   * collapse into one derivation run. */
  private async ensureFreshMaterial(input: {
    params: SecretDurableObjectStructuredName;
    state: SecretState;
  }): Promise<string> {
    const { params } = input;
    let state = input.state;
    if (state.status !== "set") {
      throw new Error(`Secret ${params.slug} is ${state.status}.`);
    }
    const stale = materialIsStale({
      hasMaterial: state.encryptedMaterial != null,
      expiresAt: state.expiresAt,
      leewaySeconds: state.derivation?.refreshLeewaySeconds ?? 0,
      nowMs: Date.now(),
    });
    if (stale && state.derivation != null) {
      await this.appendDeriveRequested({ params, state, reason: "inline-refresh" });
      state = await this.waitForVersionAbove(params.slug, state.version);
    }
    if (state.encryptedMaterial == null) {
      throw new Error(`Secret ${params.slug} has no material and no derivation.`);
    }
    return await decryptSecretMaterial({
      key: await this.encryptionKey(),
      encrypted: state.encryptedMaterial,
    });
  }

  private async appendDeriveRequested(input: {
    params: SecretDurableObjectStructuredName;
    state: SecretState;
    reason: string;
  }) {
    const stream = await this.secretStream(input.params);
    await stream.append({
      type: "events.iterate.com/secret/derive-requested",
      idempotencyKey: `secret-derive:${input.params.slug}:v${input.state.version}`,
      payload: {
        slug: input.params.slug,
        staleVersion: input.state.version,
        reason: input.reason,
      },
    });
  }

  /** Poll the fold until the processor's rotation lands. */
  private async waitForVersionAbove(slug: string, staleVersion: number): Promise<SecretState> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { state } = await this.secret.snapshot();
      if (state.version > staleVersion) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Secret ${slug} derivation did not complete in time.`);
  }

  private async readyState() {
    const params = await this.ensureParams();
    await this.ensureSecretSubscription(params);
    await this.waitForCatchUp(params);
    const snapshot = await this.secret.snapshot();
    return { params, state: snapshot.state };
  }

  private async encryptionKey() {
    if (!this.env.SECRETS_ENCRYPTION_KEY) {
      throw new Error("SECRETS_ENCRYPTION_KEY is not configured for this deployment.");
    }
    return await importSecretsKey(this.env.SECRETS_ENCRYPTION_KEY);
  }

  private async appendUsedEvent(input: {
    params: SecretDurableObjectStructuredName;
    usage: "fetch" | "reveal";
    usedBy: string;
    urlHost?: string;
  }) {
    const stream = await this.secretStream(input.params);
    await stream.append({
      type: "events.iterate.com/secret/used",
      idempotencyKey: `secret-used:${crypto.randomUUID()}`,
      payload: {
        slug: input.params.slug,
        usedBy: input.usedBy,
        usage: input.usage,
        ...(input.urlHost == null ? {} : { urlHost: input.urlHost }),
        at: new Date().toISOString(),
      },
    });
  }

  private async secretStream(params: SecretDurableObjectStructuredName) {
    return await getInitializedStreamStub({
      durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: params.projectId,
      path: secretStreamPath(params.slug),
    });
  }

  private async waitForCatchUp(params: SecretDurableObjectStructuredName) {
    await waitForProcessorCatchUp({
      consumes: this.secret.contract.consumes,
      snapshot: () => this.secret.snapshot(),
      stream: await this.secretStream(params),
    });
  }

  private async ensureSecretSubscription(params: SecretDurableObjectStructuredName) {
    const stream = await this.secretStream(params);
    await stream.append({
      type: STREAM_SUBSCRIPTION_CONFIGURED_TYPE,
      idempotencyKey: `secret-subscription:${params.projectId}:${params.slug}`,
      payload: {
        subscriptionKey: `secret:${params.projectId}:${params.slug}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "SECRET",
          durableObjectName: getSecretDurableObjectName(params),
          processorName: SecretProcessorContract.slug,
        }),
      },
    });
  }
}
