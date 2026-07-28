import { DurableObject } from "cloudflare:workers";
import { LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import { isStreamOffsetConflictError } from "iterate/processors";
import type { StreamEventInput } from "iterate/processors";
import type { ProcessorState } from "iterate/processors";
import {
  workerDeploymentVersion,
  workerVersion,
  type Env,
  type WorkerDeploymentVersion,
} from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { parseConfig } from "../../config.ts";
import {
  assertGithubInstallationTokenMintAuthorized,
  mintGithubInstallationToken,
} from "../integrations/github-app.ts";
import { assertPushTokenSecretRevision } from "../devices/push-token-consistency.ts";
import { secretCreationEvents } from "./secret-defaults.ts";
import type {
  SecretCreateInput,
  SecretDescription,
  SecretRefresh,
  SecretUpdateInput,
} from "./types.ts";
import { decryptSecretCellMaterial, encryptSecretCellMaterial } from "./crypto.ts";
import { fetchWithCredentialRedirects } from "./credential-fetch.ts";
import { resolvePlatformClientCreds, resolvePlatformGithubAppKey } from "./platform-secrets.ts";
import { SecretProcessorContract } from "./secret-processor-contract.ts";
import { SecretProcessor } from "./secret-processor-implementation.ts";
import {
  secretErrorResponse,
  secretReferencesFromRequest,
  selectSecretField,
  substituteSecretRequest,
  SecretSubstitutionError,
} from "./utils.ts";
import { withWebSocketHandshakeHeaders } from "./websocket-handshake.ts";

type SecretState = ProcessorState<typeof SecretProcessorContract>;
type SecretSnapshot = { offset: number; state: SecretState };
const MAX_MATERIAL_APPEND_ATTEMPTS = 8;
// Secret reduction is pure and normally completes during catchUp. If ingestion
// is broken, fail the command instead of retaining its RPC forever.
const INGEST_WAIT_TIMEOUT_MS = 15_000;

/**
 * One path-addressed secret. THE INVARIANT (the whole design, one sentence):
 * material goes in; nothing comes out except a request to a pinned host.
 *
 * There is no read lane, no reveal lane, no compute lane. The only verb that
 * touches material is `fetch()`: substitute `getSecret(...)` placeholders in
 * trusted DO code and dispatch to a host on the secret's egress allowlist.
 * Credential refresh is a NAMED STRATEGY run by this same trusted code
 * (`refresh` on the reduced state) whose exchange endpoint must itself fall
 * within the pin — so a refresh, like any use, only ever moves bytes toward
 * pinned hosts.
 *
 * WebSocket upgrades use this same fetch lane: placeholders in the handshake
 * headers or URL are substituted before opening the pinned upstream socket.
 * Application frames are opaque and are never scanned for placeholders.
 */
export class SecretDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): WorkerDeploymentVersion {
    return workerDeploymentVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
    // Secret material is write-only: the live state that leaves this DO is the
    // DESCRIPTION (hasMaterial), never the ciphertext — same redaction the
    // processor facade applies via publicState. The explicit return type does
    // double duty: it makes the registry a LiveState<SecretDescription>, and
    // it breaks the field-initializer inference cycle (this closure reads
    // #reads, which is built from this registry).
    getLiveState: (): SecretDescription => describeSecretState(this.#reads.currentState),
  });
  // The DO constructs the processor — no host-injected readState/writeState/
  // keepAliveWhile deps; the runner owns durable progress and keepalive. NO
  // recovery on purpose: the processor's only side effect (the secret/created
  // catalog cross-post) is a blocked per-event append — the cursor holds until
  // it commits, so an eviction just redelivers the event; there is no
  // runInBackground work an eviction could lose (see the registry module
  // doc's rule).
  readonly #secretProcessor = this.#registry.register(
    new SecretProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (snapshots, the processor facade, live state) must go
  // through the runner's committed progress.
  readonly #reads = this.#registry.reads(this.#secretProcessor);

  // In-flight refresh, shared across concurrent callers (single-flight): a
  // burst of 401s must not fan out into N token exchanges — duplicate mints
  // trip provider rate limits and race last-write-wins on the stored token.
  #refreshing: Promise<void> | undefined;

  // update() snapshots the next stream offset, encrypts for that exact commit,
  // then compare-and-appends. Serialize local callers to avoid wasted crypto;
  // public stream appends remain concurrent and are handled by the assertion.
  #updates: Promise<void> = Promise.resolve();

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#reads), never the processor instance — see the
    // field comment: instance reads are stale forever under runner drive.
    return new StreamProcessorRpcTarget(this.#reads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(SecretProcessorContract.slug),
      // Secret material is write-only: the live state that leaves this DO is
      // the DESCRIPTION — snapshots and onStateChange pushes must never carry
      // the ciphertext, only the hasMaterial fact.
      publicState: describeSecretState,
    });
  }

  /** The secret's live state — the DESCRIPTION only, behind `itx.secrets.get(path).liveState`. */
  get liveState() {
    return new LiveStateRpcTarget<SecretDescription>(this.#registry);
  }

  create(input: SecretCreateInput) {
    const result = this.#updates.then(() => this.#create(input));
    this.#updates = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #create(input: SecretCreateInput) {
    const egress = normalizeEgress(input.egress);
    const visibility = input.visibility ?? "write-only";
    // Readable and substitutable are mutually exclusive kinds: material
    // leaves via reveal() OR via pinned egress substitution, never both. The
    // matching update() guard makes this an INVARIANT, not a default — a
    // readable secret can never later grow an egress pin.
    if (visibility === "readable" && egress.urls.length > 0) {
      throw new Error(
        `a readable secret cannot have egress origins: ${this.#name.path} (readable material leaves via reveal(), never substitution)`,
      );
    }
    const idempotencyKey = `secret/created:${this.#name.projectId}:${this.#name.path}`;

    const existing = await this.#stream.getEvent({ idempotencyKey });
    if (existing !== undefined) {
      // Duplicate create. The stream's same-key-different-body rejection
      // cannot police secret payloads (encrypted material has a fresh IV per
      // encryption), so the loud different-payload failure lives here: the
      // comparable birth policy must match exactly. Material is write-only
      // and NOT comparable — an identical-policy create keeps the existing
      // material (the ensure-create-then-reveal pairing flow depends on
      // this); rotation goes through update().
      this.#assertCreateMatchesBirth(existing.payload, {
        egress,
        refresh: input.refresh ?? null,
        visibility,
      });
      const [, subscription] = secretCreationEvents({
        path: this.#name.path,
        payload: { config: { egress, refresh: input.refresh ?? null, visibility } },
        projectId: this.#name.projectId,
      });
      const [configured] = await this.#stream.append(subscription!);
      await this.#waitUntilProcessed(configured!.offset);
      return existing;
    }

    for (let attempt = 1; attempt <= MAX_MATERIAL_APPEND_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshotWithOffset();
      if (snapshot.state.birthCertificate !== null) {
        throw new Error(`secret already created: ${this.#name.path}`);
      }
      const offset = snapshot.offset + 1;
      const encryptedMaterial =
        input.material === undefined
          ? undefined
          : await encryptSecretCellMaterial(
              JSON.stringify(input.material),
              this.env.SECRET_ENCRYPTION_KEY,
              {
                egressOrigins: egressOrigins(egress),
                offset,
                path: this.#name.path,
                projectId: this.#name.projectId,
              },
            );
      try {
        const [created, configured] = await this.#stream.append(
          ...secretCreationEvents({
            offset,
            path: this.#name.path,
            payload: {
              config: {
                egress,
                ...(encryptedMaterial === undefined ? {} : { encryptedMaterial }),
                refresh: input.refresh ?? null,
                visibility,
              },
            },
            projectId: this.#name.projectId,
          }),
        );
        await this.#waitUntilProcessed(Math.max(created!.offset, configured!.offset));
        return created!;
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_MATERIAL_APPEND_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error("unreachable secret create retry state");
  }

  /** The loud duplicate-create check: the retried policy must equal the birth
   * certificate's (egress origins, refresh strategy, visibility). Material is
   * deliberately excluded — see the call site. */
  #assertCreateMatchesBirth(
    birthPayload: unknown,
    requested: {
      egress: { urls: string[] };
      refresh: SecretRefresh | null;
      visibility: "write-only" | "readable";
    },
  ): void {
    const born =
      SecretProcessorContract.events["events.iterate.com/secret/created"].payloadSchema.parse(
        birthPayload,
      ).config;
    const mismatches: string[] = [];
    if (JSON.stringify(born.egress.urls) !== JSON.stringify(requested.egress.urls)) {
      mismatches.push("egress");
    }
    if (!sameRefresh(born.refresh, requested.refresh)) mismatches.push("refresh");
    if (born.visibility !== requested.visibility) mismatches.push("visibility");
    if (mismatches.length > 0) {
      throw new Error(
        `secret already created with a different ${mismatches.join("/")} policy: ${this.#name.path} (use update() to change an existing secret)`,
      );
    }
  }

  update(input: SecretUpdateInput) {
    const result = this.#updates.then(() => this.#update(input));
    this.#updates = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** @internal Atomically clear material only when the caller still names the
   * exact material/policy revision it used. This prevents a late provider
   * rejection from deleting a credential that rotated while the request was
   * in flight. */
  clearMaterialIfUpdatedOffset(input: { expectedUpdatedOffset: number }) {
    const result = this.#updates.then(() => this.#clearMaterialIfUpdatedOffset(input));
    this.#updates = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #clearMaterialIfUpdatedOffset(input: { expectedUpdatedOffset: number }): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_MATERIAL_APPEND_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshotWithOffset();
      if (snapshot.state.updatedOffset !== input.expectedUpdatedOffset) return false;
      if (snapshot.state.encryptedMaterial === null) return true;
      try {
        const [event] = await this.#appendSecretEvent({
          offset: snapshot.offset + 1,
          type: "events.iterate.com/secret/updated",
          payload: { egress: snapshot.state.egress },
        });
        await this.#waitUntilProcessed(event!.offset);
        return true;
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_MATERIAL_APPEND_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error("unreachable conditional secret clear retry state");
  }

  async #update(input: SecretUpdateInput) {
    if (input.material === undefined && input.egress === undefined && input.refresh === undefined) {
      throw new Error("secret.update requires material, egress, or refresh");
    }
    if (input.material !== undefined && input.egress === undefined) {
      throw new Error("secret.update requires egress with replacement material");
    }
    const initialSnapshot = await this.#snapshotWithOffset();
    assertSecretCreated(initialSnapshot.state, this.#name.path);

    const egress = input.egress === undefined ? undefined : normalizeEgress(input.egress);
    // The create()-side exclusivity as an invariant: a readable secret's
    // "never substituted outbound" property must survive every later update.
    if (
      initialSnapshot.state.birthCertificate?.config.visibility === "readable" &&
      egress !== undefined &&
      egress.urls.length > 0
    ) {
      throw new Error(
        `a readable secret cannot have egress origins: ${this.#name.path} (readable material leaves via reveal(), never substitution)`,
      );
    }

    // A material-less update is intentionally destructive in the reduction. It
    // needs no privileged append lane: egress, refresh, and audit facts are all
    // ordinary public stream coordination.
    if (input.material === undefined) {
      const [event] = await this.#appendSecretEvent({
        type: "events.iterate.com/secret/updated",
        payload: {
          ...(egress === undefined ? {} : { egress }),
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
        },
      });
      await this.#waitUntilProcessed(event!.offset);
      return event!;
    }

    // Encryption authenticates the committed offset, so contention means the
    // blob must be thrown away and recomputed for a fresh snapshot.
    for (let attempt = 1; attempt <= MAX_MATERIAL_APPEND_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshotWithOffset();
      assertSecretCreated(snapshot.state, this.#name.path);
      try {
        const event = await this.#appendMaterialUpdate({
          egress: egress!,
          material: input.material,
          offset: snapshot.offset + 1,
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
        });
        await this.#waitUntilProcessed(event.offset);
        return event;
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_MATERIAL_APPEND_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error("unreachable material append retry state");
  }

  async describe(): Promise<SecretDescription> {
    // update() appends to the stream and the processor reduces it in
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
    return await this.#fetch(request, { kind: "any-revision" });
  }

  async fetchAtUpdatedOffset(
    request: Request,
    input: { expectedUpdatedOffset: number },
  ): Promise<Response> {
    return await this.#fetch(request, {
      kind: "exact-revision",
      updatedOffset: input.expectedUpdatedOffset,
    });
  }

  async #fetch(
    request: Request,
    revision: { kind: "any-revision" } | { kind: "exact-revision"; updatedOffset: number },
  ): Promise<Response> {
    const { problems, references } = await secretReferencesFromRequest(request);
    if (problems[0] !== undefined) return secretErrorResponse(problems[0].code);
    if (references.length === 0) return secretErrorResponse("secret_reference_required");
    if (references.some((reference) => reference.path !== this.#name.path)) {
      // One request, one secret: cross-secret chaining is not supported.
      return secretErrorResponse("secret_reference_foreign");
    }

    try {
      let state = await this.#snapshot();
      assertSecretCreated(state, this.#name.path);
      assertSecretRevision(state, revision);
      assertOriginPinned(request.url, state);

      // A refresh-and-retry needs the body twice; clone while it is still
      // undisturbed. (The cast is workers-types Request<Cf> vs bare Request.)
      let retry =
        state.refresh === null
          ? null
          : {
              source: request.clone() as unknown as Request,
              strategy: state.refresh,
              updatedOffset: state.updatedOffset,
            };

      let substituted: Request;
      try {
        substituted = await this.#substitute(request, state);
      } catch (error) {
        // No material / missing field with a strategy configured: mint first
        // (the first-use case — e.g. a fresh GitHub installation), then retry.
        if (retry === null || !isMintableMiss(error)) throw error;
        await this.#refresh(retry);
        state = await this.#snapshot();
        assertSecretRevision(state, revision);
        substituted = await this.#substitute(retry.source, state);
        retry = null; // one refresh per request: a just-minted token gets no second go
      }

      await this.#appendUsed(request.url);
      await this.#assertGithubInstallationUseAuthorized(state.refresh);
      const response = await fetchWithCredentialRedirects(substituted, {
        assertUrlAllowed: (url) => assertOriginPinned(url, state),
      });
      if (response.status !== 401 || retry === null) {
        return await withWebSocketHandshakeHeaders(request, response);
      }

      try {
        await this.#refresh(retry);
      } catch {
        // The provider (or config) refused the refresh: the original 401 is
        // the caller's answer, not an opaque exception.
        return await withWebSocketHandshakeHeaders(request, response);
      }
      const retriedState = await this.#snapshot();
      assertSecretRevision(retriedState, revision);
      const retried = await this.#substitute(retry.source, retriedState);
      await this.#appendUsed(request.url);
      await this.#assertGithubInstallationUseAuthorized(retriedState.refresh);
      return await withWebSocketHandshakeHeaders(
        request,
        await fetchWithCredentialRedirects(retried, {
          assertUrlAllowed: (url) => assertOriginPinned(url, retriedState),
        }),
      );
    } catch (error) {
      if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
      throw error;
    }
  }

  /**
   * Read the material back — ONLY for a secret whose birth certificate
   * declared `visibility: "readable"`. Visibility is immutable (create-time
   * only, never updatable), so the write-only invariant survives per
   * secret: a secret born write-only can never be retro-flipped readable.
   * Readable secrets exist for credentials whose whole purpose is to be
   * SHOWN to the outside, as often as needed — the born project ingress key
   * is the canonical case.
   */
  async reveal(): Promise<unknown> {
    const { state } = await this.#snapshotWithOffset();
    assertSecretCreated(state, this.#name.path);
    if (state.birthCertificate?.config.visibility !== "readable") {
      throw new Error(`secret is write-only (not born readable): ${this.#name.path}`);
    }
    if (state.encryptedMaterial === null) return null;
    return await this.#decrypt(state.encryptedMaterial, state.egress);
  }

  /**
   * Compare one material field (or the whole plain-string material, when
   * `field` is omitted) against a caller-supplied candidate. The material
   * never leaves this object — the answer is one bit. This is the verifier
   * behind the `project-secret` /api credential (auth.ts): the candidate
   * arrives from the UNAUTHENTICATED door, so the comparison is
   * constant-time (HMAC both sides under a throwaway key, so neither length
   * nor prefix leaks through timing) and a missing/uncreated/structured-only
   * secret answers false rather than throwing.
   */
  async verifyMaterialField(input: { field?: string; value: string }): Promise<boolean> {
    const { state } = await this.#snapshotWithOffset();
    if (state.encryptedMaterial === null) return false;
    const material = await this.#decrypt(state.encryptedMaterial, state.egress);
    let expected: unknown;
    try {
      expected = selectSecretField(material, input.field);
    } catch {
      return false;
    }
    if (typeof expected !== "string" || expected.length === 0) return false;
    return await constantTimeStringEquals(expected, input.value);
  }

  /** Substitute this secret's placeholders (headers, URL path, opted-in JSON) from material. */
  async #substitute(request: Request, state: SecretState): Promise<Request> {
    const material =
      state.encryptedMaterial === null
        ? null
        : await this.#decrypt(state.encryptedMaterial, state.egress);
    return substituteSecretRequest(request, (reference) => {
      if (material === null) throw new SecretSubstitutionError("secret_not_found");
      return selectSecretField(material, reference.field);
    });
  }

  #refresh(expected: { strategy: SecretRefresh; updatedOffset: number }): Promise<void> {
    this.#refreshing ??= this.#doRefresh(expected).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #assertGithubInstallationUseAuthorized(refresh: SecretRefresh | null): Promise<void> {
    if (refresh?.kind !== "github-app-installation") return;
    try {
      await assertGithubInstallationTokenMintAuthorized({
        installationId: refresh.installationId,
        privateKey: refresh.privateKey,
        projectId: this.#name.projectId,
      });
    } catch {
      throw new SecretSubstitutionError("secret_not_found");
    }
  }

  async #doRefresh(expected: { strategy: SecretRefresh; updatedOffset: number }): Promise<void> {
    const snapshot = await this.#snapshotWithOffset();
    const { state } = snapshot;
    if (
      state.updatedOffset !== expected.updatedOffset ||
      !sameRefresh(state.refresh, expected.strategy)
    ) {
      // fetch() selected this strategy from an earlier snapshot. A public
      // event may freely replace or clear it, but the stale strategy must not
      // mint after that change. The append offset check below independently
      // fences changes that land after this snapshot.
      throw new SecretSubstitutionError("secret_not_found");
    }
    const material =
      state.encryptedMaterial === null
        ? {}
        : await this.#decrypt(state.encryptedMaterial, state.egress);
    const record = asMaterialRecord(material);
    const refresh = expected.strategy;
    if (refresh.kind === "oauth-refresh-token") {
      await this.#refreshOAuthToken(refresh, snapshot, record);
    } else if (refresh.kind === "github-app-installation") {
      await this.#mintGithubInstallationToken(refresh, snapshot, record);
    } else {
      await this.#mintWaitroseSession(refresh, snapshot, record);
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
    snapshot: SecretSnapshot,
    material: Record<string, unknown>,
  ): Promise<void> {
    const { state } = snapshot;
    assertOriginPinned(refresh.tokenEndpoint, state);
    const refreshToken = readStringField(material, "refreshToken");
    // Material creds may be a confidential client (clientId + clientSecret) or a
    // PUBLIC client (clientId only — e.g. a dynamically-registered MCP client);
    // platform creds are always confidential.
    const creds =
      refresh.clientCreds === "material"
        ? {
            clientId: readStringField(material, "clientId"),
            clientSecret: optionalStringField(material, "clientSecret"),
          }
        : resolvePlatformClientCreds({
            config: parseConfig(this.env),
            ref: refresh.clientCreds,
            secretEgressUrls: state.egress.urls,
            tokenEndpoint: refresh.tokenEndpoint,
          });
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    // A confidential client authenticates with HTTP Basic; a public client (no
    // secret) instead identifies itself with client_id in the body (RFC 6749 §6).
    if (creds.clientSecret === undefined) body.set("client_id", creds.clientId);
    const response = await fetchWithCredentialRedirects(
      new Request(refresh.tokenEndpoint, {
        method: "POST",
        headers: {
          ...(creds.clientSecret === undefined
            ? {}
            : { authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}` }),
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      }),
      { assertUrlAllowed: (url) => assertOriginPinned(url, state) },
    );
    if (!response.ok) throw new Error(`oauth refresh failed with HTTP ${response.status}`);
    const data = (await response.json()) as { access_token?: string; refresh_token?: string };
    if (typeof data.access_token !== "string") {
      throw new Error("oauth refresh returned no access_token");
    }
    await this.#commitRefreshedMaterial(
      {
        ...material,
        accessToken: data.access_token,
        // Providers may rotate the refresh token on use; keep the newest.
        ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
      },
      snapshot,
    );
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
    snapshot: SecretSnapshot,
    material: Record<string, unknown>,
  ): Promise<void> {
    const { state } = snapshot;
    assertOriginPinned(refresh.apiBase, state);
    let privateKeyPem: string;
    if (refresh.privateKey === "material") {
      privateKeyPem = readStringField(material, "privateKey");
    } else {
      await this.#assertGithubInstallationUseAuthorized(refresh);
      privateKeyPem = resolvePlatformGithubAppKey({
        apiBase: refresh.apiBase,
        appId: refresh.appId,
        config: parseConfig(this.env),
        ref: refresh.privateKey,
        secretEgressUrls: state.egress.urls,
      });
    }
    const token = await mintGithubInstallationToken({
      apiBase: refresh.apiBase,
      appId: refresh.appId,
      installationId: refresh.installationId,
      privateKeyPem,
    });
    await this.#commitRefreshedMaterial({ ...material, accessToken: token }, snapshot);
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
    snapshot: SecretSnapshot,
    material: Record<string, unknown>,
  ): Promise<void> {
    const { state } = snapshot;
    assertOriginPinned(refresh.graphqlUrl, state);
    const username = readStringField(material, "username");
    const password = readStringField(material, "password");
    const response = await fetchWithCredentialRedirects(
      new Request(refresh.graphqlUrl, {
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
      }),
      { assertUrlAllowed: (url) => assertOriginPinned(url, state) },
    );
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
    await this.#commitRefreshedMaterial(
      { ...material, accessToken: session.accessToken },
      snapshot,
    );
  }

  async #snapshot(): Promise<SecretState> {
    return (await this.#snapshotWithOffset()).state;
  }

  async #snapshotWithOffset(): Promise<SecretSnapshot> {
    await this.#registry.catchUp(SecretProcessorContract.slug);
    return await this.#reads.snapshot();
  }

  async #waitUntilProcessed(offset: number): Promise<void> {
    // The offset wait is the single bounded read-your-writes door: it
    // self-pulls when the runner is behind. A separate catchUp here would put
    // an unbounded Stream RPC in front of the timeout and can orphan the
    // command even after the target Stream DO finished serving the read.
    await this.#reads.waitUntilEvent({ offset, timeoutMs: INGEST_WAIT_TIMEOUT_MS });
  }

  async #decrypt(
    encrypted: NonNullable<SecretState["encryptedMaterial"]>,
    egress: SecretState["egress"],
  ): Promise<unknown> {
    try {
      return JSON.parse(
        await decryptSecretCellMaterial(encrypted, this.env.SECRET_ENCRYPTION_KEY, {
          egressOrigins: egressOrigins(egress),
          offset: encrypted.offset,
          path: this.#name.path,
          projectId: this.#name.projectId,
        }),
      );
    } catch {
      // Invalid, copied, or policy-mismatched ciphertext is indistinguishable
      // from no material and never leaks a raw WebCrypto exception.
      throw new SecretSubstitutionError("secret_not_found");
    }
  }

  async #appendMaterialUpdate(input: {
    egress: SecretState["egress"];
    material: unknown;
    offset: number;
    refresh?: SecretRefresh | null;
  }) {
    const encryptedMaterial = await encryptSecretCellMaterial(
      JSON.stringify(input.material),
      this.env.SECRET_ENCRYPTION_KEY,
      {
        egressOrigins: egressOrigins(input.egress),
        offset: input.offset,
        path: this.#name.path,
        projectId: this.#name.projectId,
      },
    );
    const [event] = await this.#appendSecretEvent({
      offset: input.offset,
      type: "events.iterate.com/secret/updated",
      payload: {
        egress: input.egress,
        encryptedMaterial,
        ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      },
    });
    return event!;
  }

  async #commitRefreshedMaterial(material: unknown, snapshot: SecretSnapshot): Promise<void> {
    let current = snapshot;
    for (let attempt = 1; attempt <= MAX_MATERIAL_APPEND_ATTEMPTS; attempt += 1) {
      // Offset-only stream facts (subscriber connection telemetry, wake facts,
      // or concurrent audit events) may advance the raw stream while a token
      // is being minted. They do not invalidate the refresh. A real secret
      // update does: updatedOffset covers material, egress, and refresh policy.
      if (
        current.state.updatedOffset !== snapshot.state.updatedOffset ||
        !sameRefresh(current.state.refresh, snapshot.state.refresh)
      ) {
        throw new SecretSubstitutionError("secret_not_found");
      }
      try {
        await this.#appendMaterialUpdate({
          egress: snapshot.state.egress,
          material,
          offset: current.offset + 1,
        });
        return;
      } catch (error) {
        if (!isStreamOffsetConflictError(error)) throw error;
        if (attempt === MAX_MATERIAL_APPEND_ATTEMPTS) {
          throw new SecretSubstitutionError("secret_not_found");
        }
        current = await this.#snapshotWithOffset();
      }
    }
  }

  #appendUsed(url: string): Promise<unknown> {
    return this.#appendSecretEvent({
      type: "events.iterate.com/secret/used",
      payload: { url, usedAt: new Date().toISOString(), usedBy: this.#name.projectId },
    });
  }

  #appendSecretEvent(event: {
    offset?: number;
    type: `events.iterate.com/secret/${string}`;
    payload: Record<string, unknown>;
  }) {
    return this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: this.#name.path,
      }),
    ).append(event as StreamEventInput);
  }
}

/** The Waitrose Android app's login mutation, verbatim (one operation, no
 * variables beyond the credential input) — the same string the vendored
 * template client carries for reference. */
const WAITROSE_NEW_SESSION_MUTATION =
  "mutation NewSession($input: SessionInput) { generateSession(session: $input) { __typename ...SessionPayload failures { type message } } }  fragment SessionPayload on SetSessionPayload { accessToken refreshToken customerId customerOrderId customerOrderState defaultBranchId expiresIn }";

function normalizeEgress(egress: { urls: string[] }): { urls: string[] } {
  for (const url of egress.urls) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`secret egress URL must use http or https: ${url}`);
    }
  }
  return { urls: [...egress.urls] };
}

function egressOrigins(egress: { urls: string[] }): string[] {
  return egress.urls.map((url) => new URL(url).origin);
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

/** Like {@link readStringField} but returns undefined instead of throwing when
 * the field is absent — for optional material (a public client has no secret). */
function optionalStringField(material: Record<string, unknown>, field: string): string | undefined {
  const value = material[field];
  return typeof value === "string" ? value : undefined;
}

function sameRefresh(current: SecretRefresh | null, expected: SecretRefresh | null): boolean {
  if (current === null || expected === null) return current === expected;
  if (current.kind !== expected.kind) return false;
  // Refresh facts are JSON values produced by the same schema. Comparing their
  // serialized form preserves the exact-fact semantics: even a configuration
  // replacement that is nearly identical invalidates an already-started use.
  return JSON.stringify(current) === JSON.stringify(expected);
}

/**
 * The one projection from internal processor state to the public description.
 * Shared by describe() and the processor facade's publicState so the two can
 * never disagree about what leaves the DO.
 */
function describeSecretState(state: SecretState): SecretDescription {
  return {
    audit: state.audit,
    created: state.birthCertificate !== null,
    egress: state.egress,
    hasMaterial: state.encryptedMaterial !== null,
    visibility: state.birthCertificate?.config.visibility ?? "write-only",
    refresh: state.refresh?.kind ?? null,
  };
}

function assertSecretCreated(state: SecretState, path: string): void {
  if (state.birthCertificate === null) {
    throw new Error(`secret has not been created: ${path}`);
  }
}

function assertSecretRevision(
  state: SecretState,
  revision: { kind: "any-revision" } | { kind: "exact-revision"; updatedOffset: number },
): void {
  if (revision.kind === "exact-revision" && state.updatedOffset !== revision.updatedOffset) {
    assertPushTokenSecretRevision(state.updatedOffset, revision.updatedOffset);
  }
}

/**
 * Constant-time string comparison for the verify lane: HMAC both values under
 * one throwaway key and compare the fixed-length digests byte-by-byte with no
 * early exit, so neither content nor LENGTH differences shape the timing.
 */
async function constantTimeStringEquals(expected: string, candidate: string): Promise<boolean> {
  const key = await crypto.subtle.generateKey({ hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const encoder = new TextEncoder();
  const [expectedDigest, candidateDigest] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(expected)),
    crypto.subtle.sign("HMAC", key, encoder.encode(candidate)),
  ]);
  const a = new Uint8Array(expectedDigest);
  const b = new Uint8Array(candidateDigest);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
