import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import type { SecretDescription, SecretRefresh, SecretUpdateInput } from "../../types.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { parseConfig } from "../../config.ts";
import { decryptSecretMaterial, encryptSecretMaterial } from "./crypto.ts";
import { resolvePlatformClientCreds, resolvePlatformGithubAppKey } from "./platform-secrets.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";
import {
  computeSignatureBase64Url,
  secretErrorResponse,
  secretReferencesFromHeaders,
  selectSecretField,
  substituteSecretHeaders,
  SecretSubstitutionError,
} from "./utils.ts";

type SecretState = InstanceType<typeof SecretProcessor>["state"];

/**
 * One path-addressed secret. THE INVARIANT (the whole design, one sentence):
 * material goes in; nothing comes out except a request to a pinned host.
 *
 * There is no read lane, no reveal lane, no compute lane. The only verb that
 * touches material is `fetch()`: substitute `getSecret(...)` placeholders in
 * trusted DO code and dispatch to a host on the secret's egress allowlist.
 * Credential refresh is a NAMED STRATEGY run by this same trusted code
 * (`refresh` on the folded state) whose exchange endpoint must itself fall
 * within the pin — so a refresh, like any use, only ever moves bytes toward
 * pinned hosts.
 *
 * WebSocket egress (an Upgrade request through this same `fetch()`) is
 * deliberately deferred, not foreclosed: it returns as a pure addition inside
 * this surface when a consumer exists.
 */
export class SecretDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  });
  readonly #secretProcessor = this.#processorHost.add((deps) => new SecretProcessor(deps));

  // In-flight refresh, shared across concurrent callers (single-flight): a
  // burst of 401s must not fan out into N token exchanges — duplicate mints
  // trip provider rate limits and race last-write-wins on the stored token.
  #refreshing: Promise<void> | undefined;

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#secretProcessor, {
      catchUpBeforeSnapshot: () => this.#processorHost.catchUp(SecretProcessorContract.slug),
      // Secret material is write-only: the live state that leaves this DO is
      // the DESCRIPTION — snapshots and onStateChange pushes must never carry
      // the ciphertext, only the hasMaterial fact.
      publicState: describeSecretState,
    });
  }

  async update(input: SecretUpdateInput) {
    if (input.material === undefined && input.egress === undefined && input.refresh === undefined) {
      throw new Error("secret.update requires material, egress, or refresh");
    }

    if (input.egress !== undefined && input.material === undefined) {
      if ((await this.#snapshot()).encryptedMaterial === null) {
        throw new Error("secret.update with egress requires existing material");
      }
    }

    const [event] = await this.#processorHost.stream.append({
      type: "events.iterate.com/secret/updated",
      payload: {
        ...(input.egress === undefined ? {} : { egress: normalizeEgress(input.egress) }),
        ...(input.material === undefined
          ? {}
          : {
              // Material is any serializable value, encrypted as one JSON blob.
              // The DO owns the JSON boundary so crypto.ts stays string-based
              // and every legacy string caller keeps round-tripping.
              encryptedMaterial: await encryptSecretMaterial(
                JSON.stringify(input.material),
                this.env.SECRET_ENCRYPTION_KEY,
              ),
            }),
        ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      },
    });
    return event!;
  }

  async describe(): Promise<SecretDescription> {
    // update() appends to the stream and the processor folds it in
    // asynchronously; pull-through makes update() -> describe()
    // read-your-writes even when the configured subscription's wake is slow
    // or was dropped.
    return describeSecretState(await this.#snapshot());
  }

  /**
   * The one lane material travels: substitute this secret's placeholders into
   * the request and dispatch it to a pinned host. With a refresh strategy
   * configured, a missing token mints before the first use and a 401 triggers
   * one refresh-and-retry — the shared strategy replaces the per-secret worker
   * that used to do exactly this.
   */
  async fetch(request: Request): Promise<Response> {
    let references;
    try {
      references = secretReferencesFromHeaders(request.headers);
    } catch {
      return secretErrorResponse("secret_reference_required");
    }
    if (references.length === 0) return secretErrorResponse("secret_reference_required");
    if (references.some((reference) => reference.path !== this.#name.path)) {
      // One request, one secret: cross-secret chaining is not supported.
      return secretErrorResponse("secret_reference_foreign");
    }
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Deferred, not foreclosed: WS egress returns inside this same surface.
      return Response.json({ error: "websocket egress is not supported yet" }, { status: 501 });
    }

    try {
      const state = await this.#snapshot();
      assertOriginPinned(request.url, state);

      // A refresh-and-retry needs the body twice; clone while it is still
      // undisturbed. (The cast is workers-types Request<Cf> vs bare Request.)
      let retry =
        state.refresh === null
          ? null
          : { source: request.clone() as unknown as Request, strategy: state.refresh };

      let substituted: Request;
      try {
        substituted = await this.#substitute(request, state);
      } catch (error) {
        // No material / missing field with a strategy configured: mint first
        // (the first-use case — e.g. a fresh GitHub installation), then retry.
        if (retry === null || !isMintableMiss(error)) throw error;
        await this.#refresh(retry.strategy);
        substituted = await this.#substitute(retry.source, await this.#snapshot());
        retry = null; // one refresh per request: a just-minted token gets no second go
      }

      await this.#appendUsed(request.url);
      const response = await fetch(substituted);
      if (response.status !== 401 || retry === null) return response;

      try {
        await this.#refresh(retry.strategy);
      } catch {
        // The provider (or config) refused the refresh: the original 401 is
        // the caller's answer, not an opaque exception.
        return response;
      }
      const retried = await this.#substitute(retry.source, await this.#snapshot());
      await this.#appendUsed(request.url);
      return await fetch(retried);
    } catch (error) {
      if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
      throw error;
    }
  }

  /** Substitute this secret's placeholders from decrypted material. */
  async #substitute(request: Request, state: SecretState): Promise<Request> {
    const material =
      state.encryptedMaterial === null ? null : await this.#decrypt(state.encryptedMaterial);
    return substituteSecretHeaders(request, (reference) => {
      if (material === null) throw new SecretSubstitutionError("secret_not_found");
      return selectSecretField(material, reference.field);
    });
  }

  #refresh(refresh: SecretRefresh): Promise<void> {
    this.#refreshing ??= this.#doRefresh(refresh).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(refresh: SecretRefresh): Promise<void> {
    const state = await this.#snapshot();
    const material =
      state.encryptedMaterial === null ? {} : await this.#decrypt(state.encryptedMaterial);
    const record = asMaterialRecord(material);
    if (refresh.kind === "oauth-refresh-token") {
      await this.#refreshOAuthToken(refresh, state, record);
    } else if (refresh.kind === "github-app-installation") {
      await this.#mintGithubInstallationToken(refresh, state, record);
    } else {
      await this.#mintWaitroseSession(refresh, state, record);
    }
  }

  /**
   * RFC 6749 refresh_token grant — the one shared implementation that replaces
   * the per-secret OAuth refresh worker. The refresh token comes from this
   * secret's own material; the Basic client credential from material
   * (bring-your-own-app) or a platform config ref (built-ins, origin-pinned in
   * platform-secrets.ts). The token endpoint must fall within this secret's
   * own egress pin: refresh only ever moves bytes toward pinned hosts.
   */
  async #refreshOAuthToken(
    refresh: Extract<SecretRefresh, { kind: "oauth-refresh-token" }>,
    state: SecretState,
    material: Record<string, unknown>,
  ): Promise<void> {
    assertOriginPinned(refresh.tokenEndpoint, state);
    const refreshToken = readStringField(material, "refreshToken");
    const creds =
      refresh.clientCreds === "material"
        ? {
            clientId: readStringField(material, "clientId"),
            clientSecret: readStringField(material, "clientSecret"),
          }
        : resolvePlatformClientCreds(
            parseConfig(this.env),
            refresh.clientCreds,
            refresh.tokenEndpoint,
          );
    const response = await fetch(refresh.tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    if (!response.ok) throw new Error(`oauth refresh failed with HTTP ${response.status}`);
    const data = (await response.json()) as { access_token?: string; refresh_token?: string };
    if (typeof data.access_token !== "string") {
      throw new Error("oauth refresh returned no access_token");
    }
    await this.update({
      material: {
        ...material,
        accessToken: data.access_token,
        // Providers may rotate the refresh token on use; keep the newest.
        ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
      },
    });
  }

  /**
   * GitHub App installation-token mint: sign an App JWT (RS256, iss = appId,
   * iat 60s in the past per GitHub's clock-drift guidance), POST it to
   * /app/installations/{id}/access_tokens on the pinned apiBase, store the
   * returned token. The private key comes from material (bring-your-own-App)
   * or the first-party platform config ref (pinned to api.github.com).
   */
  async #mintGithubInstallationToken(
    refresh: Extract<SecretRefresh, { kind: "github-app-installation" }>,
    state: SecretState,
    material: Record<string, unknown>,
  ): Promise<void> {
    assertOriginPinned(refresh.apiBase, state);
    const privateKeyPem =
      refresh.privateKey === "material"
        ? readStringField(material, "privateKey")
        : resolvePlatformGithubAppKey(parseConfig(this.env), refresh.privateKey, refresh.apiBase);
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${base64UrlOfJson({ alg: "RS256", typ: "JWT" })}.${base64UrlOfJson({
      iat: now - 60,
      exp: now + 540,
      iss: refresh.appId,
    })}`;
    const signature = await computeSignatureBase64Url({ payload: signingInput, privateKeyPem });
    const response = await fetch(
      `${refresh.apiBase.replace(/\/$/, "")}/app/installations/${refresh.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${signingInput}.${signature}`,
          "user-agent": "iterate-os",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`github installation token mint failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { token?: string };
    if (typeof data.token !== "string") {
      throw new Error("github installation token mint returned no token");
    }
    await this.update({ material: { ...material, accessToken: data.token } });
  }

  /**
   * Waitrose session mint: POST the `NewSession` GraphQL mutation (the login
   * the reverse-engineered Android app performs) to the pinned graphqlUrl with
   * `username`/`password` from this secret's own material, store the returned
   * accessToken. Waitrose has no refresh grant — re-login IS the refresh — so
   * this one strategy covers both the first-use mint and the 401 re-mint. The
   * password never leaves this method except inside the mutation body toward
   * the pinned host, and never appears in an error or a log.
   */
  async #mintWaitroseSession(
    refresh: Extract<SecretRefresh, { kind: "waitrose-session" }>,
    state: SecretState,
    material: Record<string, unknown>,
  ): Promise<void> {
    assertOriginPinned(refresh.graphqlUrl, state);
    const username = readStringField(material, "username");
    const password = readStringField(material, "password");
    const response = await fetch(refresh.graphqlUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // Waitrose's edge answers UA-less requests with HTTP 520 (proven live
        // 2026-07-07); the Android app's UA is the known-good request shape.
        "user-agent": "Waitrose/3.9.1 (Android)",
      },
      body: JSON.stringify({
        query: WAITROSE_NEW_SESSION_MUTATION,
        variables: { input: { clientId: "ANDROID_APP", password, username } },
      }),
    });
    if (response.status === 401) {
      // The live API answers wrong credentials with a 401 GraphQL error (the
      // failures[] shape below is the app-client contract, not what the edge
      // actually returns) — name the fix without echoing the credential.
      throw new Error(
        "waitrose session mint refused (HTTP 401): check the connection secret's username/password",
      );
    }
    if (!response.ok) throw new Error(`waitrose session mint failed with HTTP ${response.status}`);
    const data = (await response.json()) as {
      data?: {
        generateSession?: {
          accessToken?: string | null;
          failures?: Array<{ message?: string; type?: string }> | null;
        };
      };
    };
    const session = data.data?.generateSession;
    if (session?.failures?.length) {
      // The provider's failure types/messages name the problem (e.g. a wrong
      // password) without carrying the credential itself.
      const reasons = session.failures.map((f) => f.type ?? f.message ?? "unknown").join(", ");
      throw new Error(`waitrose session mint refused: ${reasons}`);
    }
    if (typeof session?.accessToken !== "string") {
      throw new Error("waitrose session mint returned no accessToken");
    }
    await this.update({ material: { ...material, accessToken: session.accessToken } });
  }

  async #snapshot(): Promise<SecretState> {
    await this.#processorHost.catchUp(SecretProcessorContract.slug);
    return (await this.#secretProcessor.snapshot()).state;
  }

  async #decrypt(encrypted: NonNullable<SecretState["encryptedMaterial"]>): Promise<unknown> {
    return JSON.parse(await decryptSecretMaterial(encrypted, this.env.SECRET_ENCRYPTION_KEY));
  }

  #appendUsed(url: string): Promise<unknown> {
    return this.#processorHost.stream.append({
      type: "events.iterate.com/secret/used",
      payload: { url, usedAt: new Date().toISOString(), usedBy: this.#name.projectId },
    });
  }
}

/** The Waitrose Android app's login mutation, verbatim (one operation, no
 * variables beyond the credential input) — the same string the vendored
 * template client carries for reference. */
const WAITROSE_NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

function normalizeEgress(egress: { urls: string[] }): { urls: string[] } {
  for (const url of egress.urls) new URL(url);
  return { urls: [...egress.urls] };
}

/** A substitution miss a refresh strategy can fill: no material yet, or the
 * referenced field (the not-yet-minted access token) absent. */
function isMintableMiss(error: unknown): boolean {
  return (
    error instanceof SecretSubstitutionError &&
    (error.code === "secret_not_found" || error.code === "secret_reference_field_not_found")
  );
}

/** An exchange endpoint must fall within the secret's own egress pin — the
 * cell invariant applies to refresh traffic exactly as to substitution. */
function assertOriginPinned(url: string, state: SecretState): void {
  const origin = new URL(url).origin;
  if (!state.egress.urls.some((pinned) => new URL(pinned).origin === origin)) {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
}

function asMaterialRecord(material: unknown): Record<string, unknown> {
  if (typeof material !== "object" || material === null || Array.isArray(material)) {
    // Non-record material cannot hold the fields a refresh strategy reads.
    throw new SecretSubstitutionError("secret_reference_field_not_found");
  }
  return material as Record<string, unknown>;
}

function readStringField(material: Record<string, unknown>, field: string): string {
  const value = material[field];
  if (typeof value !== "string") {
    throw new SecretSubstitutionError("secret_reference_field_not_found");
  }
  return value;
}

function base64UrlOfJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The one projection from internal processor state to the public description.
 * Shared by describe() and the processor facade's publicState so the two can
 * never disagree about what leaves the DO.
 */
function describeSecretState(state: SecretState): SecretDescription {
  return {
    audit: state.audit,
    egress: state.egress,
    hasMaterial: state.encryptedMaterial !== null,
    refresh: state.refresh?.kind ?? null,
  };
}
