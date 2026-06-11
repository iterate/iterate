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
// Refresh also lives here: when a material version carries an OAuth refresh
// config, the DO arms its alarm at expiry-minus-leeway and appends
// `secret/rotated` (re-encrypted) when it fires. The journal stays the only
// write authority; this DO is a fold plus a clock.

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

  /** Material-free public view of the Secret. */
  async describe() {
    const { state } = await this.readyState();
    const { encryptedMaterial: _material, refresh, ...visible } = state;
    return { ...visible, hasRefresh: refresh != null };
  }

  /**
   * Perform an HTTP request with `{{secret}}` placeholders (url, header
   * values, string body) replaced by the decrypted material. The substituted
   * request and live response exist only inside this DO; the caller gets a
   * serializable response snapshot. Every call appends a `secret/used` audit
   * event.
   */
  async fetchWithSecret(input: { request: SubstitutableRequest; usedBy: string }) {
    const { params, state } = await this.readyState();
    const material = await this.decryptCurrentMaterial(state);
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
   * loopback capabilities constructing SDK clients, and the Discord gateway
   * building its identify frame. Project worker code and agents never get a
   * dial on this — they go through fetchWithSecret or egress substitution.
   */
  async revealForPlatformUse(input: { usedBy: string }) {
    const { params, state } = await this.readyState();
    const material = await this.decryptCurrentMaterial(state);
    await this.appendUsedEvent({ params, usage: "reveal", usedBy: input.usedBy });
    return material;
  }

  /** Refresh the material via the journaled OAuth refresh config, appending a
   * `secret/rotated` event with the re-encrypted result. */
  async refreshNow(): Promise<{ refreshed: boolean; reason?: string }> {
    const { params, state } = await this.readyState();
    const refresh = state.refresh;
    if (state.status !== "set" || refresh == null) {
      return { refreshed: false, reason: "no refresh config" };
    }
    if (refresh.encryptedRefreshToken == null) {
      return { refreshed: false, reason: "no refresh token" };
    }
    const key = await this.encryptionKey();
    const refreshToken = await decryptSecretMaterial({
      key,
      encrypted: refresh.encryptedRefreshToken,
    });
    // The OAuth client secret is itself a Secret — dereferenced via its own
    // DO's audited trapdoor, so even refresh flows leave a `secret/used` trail.
    const clientSecret = refresh.clientSecretSecretSlug
      ? await getSecretStub({
          projectId: params.projectId,
          slug: refresh.clientSecretSecretSlug,
        }).revealForPlatformUse({ usedBy: `secret:${params.slug}:refresh` })
      : undefined;

    const response = await fetch(refresh.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: refresh.clientId,
        ...(clientSecret == null ? {} : { client_secret: clientSecret }),
      }),
    });
    const tokenData = (await response.json()) as {
      access_token?: string;
      error?: string;
      expires_in?: number;
    };
    if (!response.ok || !tokenData.access_token) {
      return { refreshed: false, reason: tokenData.error ?? `HTTP ${response.status}` };
    }

    const stream = await this.secretStream(params);
    await stream.append({
      type: "events.iterate.com/secret/rotated",
      idempotencyKey: `secret-rotated:${params.slug}:${crypto.randomUUID()}`,
      payload: {
        slug: params.slug,
        encryptedMaterial: await encryptSecretMaterial({ key, material: tokenData.access_token }),
        ...(tokenData.expires_in == null
          ? {}
          : { expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString() }),
        reason: "oauth-refresh",
      },
    });
    return { refreshed: true };
  }

  async alarm() {
    const result = await this.refreshNow();
    if (!result.refreshed) {
      console.warn("[secret] alarm refresh did not rotate material", result);
    }
  }

  async ensureReady() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureSecretSubscription(params);
    await this.waitForCatchUp(params);
    return await this.secret.snapshot();
  }

  private async readyState() {
    const params = await this.ensureStartedOrInitializeFromRuntimeName();
    await this.ensureSecretSubscription(params);
    await this.waitForCatchUp(params);
    const snapshot = await this.secret.snapshot();
    return { params, state: snapshot.state };
  }

  private async decryptCurrentMaterial(
    state: Awaited<ReturnType<SecretDurableObject["secret"]["snapshot"]>>["state"],
  ) {
    if (state.status !== "set" || state.encryptedMaterial == null) {
      throw new Error(`Secret ${state.slug ?? "(unset)"} has no material.`);
    }
    return await decryptSecretMaterial({
      key: await this.encryptionKey(),
      encrypted: state.encryptedMaterial,
    });
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
