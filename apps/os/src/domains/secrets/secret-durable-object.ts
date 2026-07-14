import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { LiveStateRpcTarget, StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { parseConfig } from "../../config.ts";
import {
  assertGithubInstallationTokenMintAuthorized,
  mintGithubInstallationToken,
} from "../integrations/github-app.ts";
import { isStreamOffsetConflictError } from "../streams/rpc-types.ts";
import type { StreamEventInput } from "../streams/schemas.ts";
import type { SecretDescription, SecretRefresh, SecretUpdateInput } from "./types.ts";
import { decryptSecretCellMaterial, encryptSecretCellMaterial } from "./crypto.ts";
import { fetchWithCredentialRedirects } from "./credential-fetch.ts";
import {
  bridgeUpstreamWebSocket,
  closeWebSocketQuietly,
  maybeBridgeWebSocketResponse,
} from "./websocket-bridge.ts";
import {
  buildIdentifyFrame,
  createUpstreamMessageBuffer,
  isSecretWebSocketRelayRequest,
  parseSecretWebSocketRelayRequest,
  type SecretWebSocketRelayInput,
  waitForJsonOp,
  waitForOpen,
} from "./websocket-relay.ts";
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

type SecretState = InstanceType<typeof SecretProcessor>["state"];
type SecretSnapshot = { offset: number; state: SecretState };
const MAX_MATERIAL_APPEND_ATTEMPTS = 8;

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
 * WebSocket egress:
 * - `fetch()` with `Upgrade: websocket` substitutes **handshake** headers/URL
 *   only (OpenAI-Realtime / browser-subprotocol shapes).
 * - `relayWebSocket()` is the **Discord IDENTIFY** shape: open a pinned wss,
 *   optionally wait for hello, send IDENTIFY with real material from this DO,
 *   then pair-bridge the rest. Frames are never scanned for placeholders —
 *   the token is composed here in trusted code (ADR 0005).
 */
export class SecretDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
    // Secret material is write-only: the live state that leaves this DO is the
    // DESCRIPTION (hasMaterial), never the ciphertext — same redaction the
    // processor facade applies via publicState. The explicit return type does
    // double duty: it makes the host a LiveState<SecretDescription>, and it
    // breaks the field-initializer inference cycle (this closure reads
    // #secretProcessor, which is built from this host).
    getLiveState: (): SecretDescription => describeSecretState(this.#secretProcessor.currentState),
  });
  readonly #secretProcessor = this.#processorHost.add((deps) => new SecretProcessor(deps));

  // In-flight refresh, shared across concurrent callers (single-flight): a
  // burst of 401s must not fan out into N token exchanges — duplicate mints
  // trip provider rate limits and race last-write-wins on the stored token.
  #refreshing: Promise<void> | undefined;

  // update() snapshots the next stream offset, encrypts for that exact commit,
  // then compare-and-appends. Serialize local callers to avoid wasted crypto;
  // public stream appends remain concurrent and are handled by the assertion.
  #updates: Promise<void> = Promise.resolve();

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  /** The keepalive's revival alarm — see stream-processor-host.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#processorHost.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
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

  /** The secret's live state — the DESCRIPTION only, behind `itx.secrets.get(path).liveState`. */
  get liveState() {
    return new LiveStateRpcTarget<SecretDescription>(this.#processorHost);
  }

  update(input: SecretUpdateInput) {
    const result = this.#updates.then(() => this.#update(input));
    this.#updates = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #update(input: SecretUpdateInput) {
    if (input.material === undefined && input.egress === undefined && input.refresh === undefined) {
      throw new Error("secret.update requires material, egress, or refresh");
    }
    if (input.material !== undefined && input.egress === undefined) {
      throw new Error("secret.update requires egress with replacement material");
    }

    const egress = input.egress === undefined ? undefined : normalizeEgress(input.egress);

    // A material-less update is intentionally destructive in the fold. It
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
      return event!;
    }

    // Encryption authenticates the committed offset, so contention means the
    // blob must be thrown away and recomputed for a fresh snapshot.
    for (let attempt = 1; attempt <= MAX_MATERIAL_APPEND_ATTEMPTS; attempt += 1) {
      const snapshot = await this.#snapshotWithOffset();
      try {
        return await this.#appendMaterialUpdate({
          egress: egress!,
          material: input.material,
          offset: snapshot.offset + 1,
          ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
        });
      } catch (error) {
        if (!isStreamOffsetConflictError(error) || attempt === MAX_MATERIAL_APPEND_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw new Error("unreachable material append retry state");
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
    // IDENTIFY relay must ride DO **fetch** so Response.webSocket survives the
    // hop (JSRPC method returns reject webSocket with DataCloneError).
    // Only SecretRpcTarget.relayWebSocket encodes this shape (magic URL + header,
    // no getSecret placeholders). Project egress that merely embeds getSecret
    // cannot invent a trusted IDENTIFY by targeting the internal URL.
    if (isSecretWebSocketRelayRequest(request)) {
      try {
        let placeholderPaths: string[] = [];
        try {
          placeholderPaths = secretReferencesFromRequest(request).map((r) => r.path);
        } catch {
          // malformed placeholder syntax is not a relay request
        }
        if (placeholderPaths.length > 0) {
          return secretErrorResponse("secret_reference_foreign");
        }
        return await this.#relayWebSocket(await parseSecretWebSocketRelayRequest(request));
      } catch (error) {
        if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: "websocket_relay_failed", message }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }

    let references;
    try {
      references = secretReferencesFromRequest(request);
    } catch {
      return secretErrorResponse("secret_reference_required");
    }
    if (references.length === 0) return secretErrorResponse("secret_reference_required");
    if (references.some((reference) => reference.path !== this.#name.path)) {
      // One request, one secret: cross-secret chaining is not supported.
      return secretErrorResponse("secret_reference_foreign");
    }

    try {
      let state = await this.#snapshot();
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
        substituted = await this.#substitute(retry.source, state);
        retry = null; // one refresh per request: a just-minted token gets no second go
      }

      await this.#appendUsed(request.url);
      await this.#assertGithubInstallationUseAuthorized(state.refresh);
      const response = await fetchWithCredentialRedirects(substituted, {
        assertUrlAllowed: (url) => assertOriginPinned(url, state),
      });
      // Pair-bridge inside the Secret DO so the socket that crosses the
      // Secret→Project fetch hop is a freshly minted pair client (constructor
      // webSocket slot), not a raw upstream fetch socket. Project egress may
      // bridge again for the ContainerProxy handoff; double-bridge is correct
      // if slightly wasteful.
      if (response.status !== 401 || retry === null) {
        return await maybeBridgeWebSocketResponse(request, response);
      }

      try {
        await this.#refresh(retry);
      } catch {
        // The provider (or config) refused the refresh: the original 401 is
        // the caller's answer, not an opaque exception.
        return await maybeBridgeWebSocketResponse(request, response);
      }
      const retriedState = await this.#snapshot();
      const retried = await this.#substitute(retry.source, retriedState);
      await this.#appendUsed(request.url);
      await this.#assertGithubInstallationUseAuthorized(retriedState.refresh);
      const retriedResponse = await fetchWithCredentialRedirects(retried, {
        assertUrlAllowed: (url) => assertOriginPinned(url, retriedState),
      });
      return await maybeBridgeWebSocketResponse(request, retriedResponse);
    } catch (error) {
      if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
      throw error;
    }
  }

  /**
   * Discord-shaped WebSocket relay: open a pinned host, send IDENTIFY with
   * material held only in this DO, return a pair-bridged 101. The caller never
   * sees the token — only subsequent app frames (ready, dispatch, echo, …).
   *
   * Private: only invoked via `fetch` with `isSecretWebSocketRelayRequest` so
   * the 101 Response.webSocket can leave the DO (JSRPC method returns cannot).
   *
   * Petshop: `wss://…/gateway` with `identify: {}` (defaults to hello → identify).
   */
  async #relayWebSocket(input: SecretWebSocketRelayInput): Promise<Response> {
    // Closed on every failure path after accept so the DO does not leak sockets.
    let upstream: WebSocket | null = null;
    let messageBuffer: ReturnType<typeof createUpstreamMessageBuffer> | null = null;
    try {
      const state = await this.#snapshot();
      if (state.encryptedMaterial === null) {
        throw new SecretSubstitutionError("secret_not_found");
      }
      await this.#assertGithubInstallationUseAuthorized(state.refresh);

      const material = await this.#decrypt(state.encryptedMaterial, state.egress);
      const token =
        input.identify === undefined
          ? null
          : selectSecretField(material, input.identify.tokenField);

      const timeoutMs = input.timeoutMs ?? 15_000;
      // Pin against the http(s) upgrade URL — egress pins are http/https only,
      // and URL.origin keeps the ws/wss scheme (wss://host ≠ https://host).
      const upgradeUrl = websocketUpgradeUrl(input.url);
      assertOriginPinned(upgradeUrl, state);
      const upgradeRequest = new Request(upgradeUrl, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      // Same redirect + pin revalidation as secret.fetch (ADR 0005): never
      // follow an off-pin Location with credential material / IDENTIFY.
      const upgradeResponse = await fetchWithCredentialRedirects(upgradeRequest, {
        assertUrlAllowed: (url) => assertOriginPinned(url, state),
      });
      upstream = upgradeResponse.webSocket;
      if (upstream == null) {
        return new Response(
          JSON.stringify({
            error: "upstream_refused_websocket",
            status: upgradeResponse.status,
          }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }

      // Accept once. Immediately buffer messages + close/error so server-first
      // frames and an early upstream hangup during open/hello/IDENTIFY/audit
      // are not lost before the pair-bridge attaches.
      upstream.accept({ allowHalfOpen: true });
      try {
        upstream.binaryType = "arraybuffer";
      } catch {
        // ignore
      }
      messageBuffer = createUpstreamMessageBuffer();
      messageBuffer.attach(upstream);

      await waitForOpen(upstream, timeoutMs);
      messageBuffer.throwIfClosed("open");

      if (input.identify !== undefined && token !== null) {
        const waitForOp =
          input.identify.waitForOp === undefined ? "hello" : input.identify.waitForOp;
        if (waitForOp !== null) {
          // Consumes hello (and any pre-hello frames) from the buffer; post-
          // hello frames stay for the client.
          await waitForJsonOp(upstream, waitForOp, timeoutMs, messageBuffer);
          messageBuffer.throwIfClosed("hello");
        }
        upstream.send(buildIdentifyFrame(token, input.identify.frame));
      }

      // Audit while still buffering — ready/dispatch/close must not race the bridge.
      await this.#appendUsed(input.url);
      messageBuffer.throwIfClosed("identify");

      messageBuffer.detach(upstream);
      const pendingUpstreamMessages = messageBuffer.frames.slice();
      messageBuffer = null;

      // Bridge after IDENTIFY so the client never sees/sends the token frame.
      // upstreamAlreadyAccepted: Workers allow accept() only once.
      return await bridgeUpstreamWebSocket(upstream, upgradeResponse, {
        upstreamAlreadyAccepted: true,
        pendingUpstreamMessages,
      });
    } catch (error) {
      if (messageBuffer !== null && upstream !== null) {
        messageBuffer.detach(upstream);
      }
      closeWebSocketQuietly(upstream, 1011, "websocket relay failed");
      if (error instanceof SecretSubstitutionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: "websocket_relay_failed", message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /** Substitute this secret's placeholders (headers + URL) from decrypted material. */
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
    await this.#processorHost.catchUp(SecretProcessorContract.slug);
    return await this.#secretProcessor.snapshot();
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
    try {
      await this.#appendMaterialUpdate({
        egress: snapshot.state.egress,
        material,
        offset: snapshot.offset + 1,
      });
    } catch (error) {
      if (isStreamOffsetConflictError(error)) {
        // The token was derived from a state that is no longer current. Never
        // resurrect it under a later policy or refresh configuration.
        throw new SecretSubstitutionError("secret_not_found");
      }
      throw error;
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

/** Normalize ws(s) → http(s) so Workers `fetch` Upgrade works. */
function websocketUpgradeUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SecretSubstitutionError("secret_not_allowed_for_origin");
  }
  return parsed.href;
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

function sameRefresh(current: SecretRefresh | null, expected: SecretRefresh): boolean {
  if (current === null || current.kind !== expected.kind) return false;
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
    egress: state.egress,
    hasMaterial: state.encryptedMaterial !== null,
    refresh: state.refresh?.kind ?? null,
  };
}
