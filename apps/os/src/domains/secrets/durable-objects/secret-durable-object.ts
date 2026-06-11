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
// DERIVED secrets live here too: a Secret whose journal carries a derivation
// (secret-derivation.ts) recomputes its material from OTHER secrets — every
// dereference goes through ensureFreshMaterial, so a stale 5-minute session
// token re-derives INLINE on use (and proactively via the alarm), each run
// appended as `secret/rotated`. Resolving a derivation's source keys dials the
// siblings' own DOs, which ensure their own freshness first — derivations
// chain, every hop audited. The journal stays the only write authority; this
// DO is a fold plus a clock plus the one place plaintext exists.

import { env } from "cloudflare:workers";
import { z } from "zod";
import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import { NotInitializedError } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/streams/workers/stream-processor-host";
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
import { deriveViaHttpExchange, materialIsStale } from "~/domains/secrets/secret-derivation.ts";
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

/** Mint a Secret DO stub from a trusted domain file (see lint rule). */
export function getSecretStub(input: SecretDurableObjectStructuredName) {
  return (env as unknown as SecretDurableObjectEnv).SECRET.getByName(
    getSecretDurableObjectName(input),
  );
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
    });
  });

  constructor(ctx: DurableObjectState, env: SecretDurableObjectEnv) {
    super(ctx, env);
    this.registerOnFirstInitialize(async (params) => {
      await this.ensureSecretSubscription(params);
    });
  }

  /** The stream subscription callable dials this (see `durableObjectProcessorSubscriber`). */
  async requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    await this.ensureStartedOrInitializeFromRuntimeName();
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

  /** Run the derivation now regardless of staleness, journaling the result. */
  async deriveNow(): Promise<{ derived: boolean; reason?: string }> {
    const { params, state } = await this.readyState();
    if (state.status !== "set" || state.derivation == null) {
      return { derived: false, reason: "no derivation" };
    }
    await this.runDerivation({ params, state, reason: "derive-now" });
    return { derived: true };
  }

  async alarm() {
    const { params, state } = await this.readyState();
    if (state.status !== "set" || state.derivation == null) return;
    try {
      await this.runDerivation({ params, state, reason: "alarm-refresh" });
    } catch (error) {
      console.warn("[secret] alarm derivation failed", { error, slug: params.slug });
    }
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureSecretSubscription(params);
    await this.waitForCatchUp(params);
    return await this.secret.snapshot();
  }

  /** Stale material + a derivation = re-derive inline, on the very use that
   * found it stale. This is what makes `getSecret({ key:
   * "waitrose/access-token" })` Just Work against a 5-minute token. */
  private async ensureFreshMaterial(input: {
    params: SecretDurableObjectStructuredName;
    state: SecretState;
  }): Promise<string> {
    const { params, state } = input;
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
      return await this.runDerivation({ params, state, reason: "inline-refresh" });
    }
    if (state.encryptedMaterial == null) {
      throw new Error(`Secret ${params.slug} has no material and no derivation.`);
    }
    return await decryptSecretMaterial({
      key: await this.encryptionKey(),
      encrypted: state.encryptedMaterial,
    });
  }

  /** Execute the derivation, append `secret/rotated`, return the material. */
  private async runDerivation(input: {
    params: SecretDurableObjectStructuredName;
    state: SecretState;
    reason: string;
  }): Promise<string> {
    const { params, state } = input;
    if (state.derivation == null) throw new Error(`Secret ${params.slug} has no derivation.`);
    if (state.derivation.kind === "script") {
      throw new Error(
        "Script derivations are declared but not executable in this spike " +
          "(they will dial the project worker's own capability).",
      );
    }

    const derived = await deriveViaHttpExchange({
      derivation: state.derivation,
      // Source secrets resolve through their OWN DOs: freshness and audit
      // compose — a derivation chain re-derives lazily, hop by hop.
      resolveSecretKey: (key) =>
        getSecretStub({ projectId: params.projectId, slug: key }).revealForPlatformUse({
          usedBy: `secret:${params.slug}:derivation`,
        }),
      nowMs: Date.now(),
    });

    const stream = await this.secretStream(params);
    await stream.append({
      type: "events.iterate.com/secret/rotated",
      idempotencyKey: `secret-rotated:${params.slug}:${crypto.randomUUID()}`,
      payload: {
        slug: params.slug,
        encryptedMaterial: await encryptSecretMaterial({
          key: await this.encryptionKey(),
          material: derived.material,
        }),
        ...(derived.expiresAt == null ? {} : { expiresAt: derived.expiresAt }),
        reason: input.reason,
      },
    });
    return derived.material;
  }

  private async readyState() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
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
    const stream = await this.secretStream(params);
    const consumedTypes = new Set<string>(this.secret.contract.consumes);
    const events = await stream.history({ before: "end" });
    const maxConsumedOffset =
      events.filter((event) => consumedTypes.has(event.type)).at(-1)?.offset ?? 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await this.secret.snapshot()).offset >= maxConsumedOffset) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async ensureStartedOrInitializeFromRuntimeName() {
    try {
      return await this.ensureStarted();
    } catch (error) {
      if (!(error instanceof NotInitializedError)) throw error;
      const runtimeName = this.getDurableObjectName();
      if (runtimeName == null) throw error;
      return await this.initialize({ name: runtimeName });
    }
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
