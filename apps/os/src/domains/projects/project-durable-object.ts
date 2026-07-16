import { DurableObject } from "cloudflare:workers";
import { trustedInternalAuthContext } from "../../auth.ts";
import { parseConfig } from "../../config.ts";
import { workerVersion, type Env } from "../../env.ts";
import {
  itxForScope,
  LiveStateRpcTarget,
  ProjectEgressInterceptRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { createStreamProcessorRegistry } from "../streams/stream-processor-registry.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import type { StreamEvent } from "../streams/schemas.ts";
import { deepRetainRpcStubs } from "../capability-host/live-capability.ts";
import { fetchWithCredentialRedirects } from "../secrets/credential-fetch.ts";
import { withWebSocketHandshakeHeaders } from "../secrets/websocket-handshake.ts";
import {
  assertPlatformApiKeyReferencesAllowed,
  substitutePlatformApiKeyReferences,
} from "../secrets/platform-secrets.ts";
import {
  platformReferencesFromHeaders,
  secretErrorResponse,
  secretReferencePathsFromRequest,
  SecretSubstitutionError,
} from "../secrets/utils.ts";
import { SlackProcessor } from "../integrations/slack-processor-implementation.ts";
import { eyesReactionTargetFromWebhookPayload } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { TelegramProcessor } from "../integrations/telegram-processor-implementation.ts";
import { connectionFromIntegrationStreamPath } from "../integrations/utils.ts";
import { EmailProcessor } from "../email/email-processor-implementation.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import type { ProjectEgressIntercept, ProjectEgressInterceptor } from "./egress.ts";
import {
  buildApprovalMessage,
  evaluateGrant,
  HumanApprovalGrantedPayload,
  HumanApprovalRejectedPayload,
  matchEgressRule,
  sha256Hex,
  type EgressRule,
  type HumanApprovalRequestedPayload,
} from "./egress-approvals.ts";
import {
  applyOpenAiAiGatewayCacheHeaders,
  isOpenAiPublicApiRequest,
  openAiAiGatewayBindingHeaders,
  openAiAiGatewayRoutingFromConfig,
  openAiGatewayBindingEndpoint,
} from "./openai-ai-gateway-egress.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";
import { StreamDatabase, type TouchInput } from "./stream-database.ts";
import { AgentStatusDatabase, type AgentStatusTouchInput } from "./agent-status-database.ts";
import type { ProjectLiveState } from "./project-live-state.ts";
import { createCloudflareProjectCustomDomainDeps } from "./custom-domains.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  #egressInterceptor?: ReturnType<typeof deepRetainRpcStubs<ProjectEgressInterceptor>>;
  // Last time #egressRules paid a catch-up — bounds rules staleness to ~5s.
  #egressRulesFreshAt = 0;
  // Demo (stateful live state): a counter every watcher of `itx.liveState` sees
  // update, mutated by `itx.liveDemo.increment()`. Proves the DO-backed,
  // shared-engine case — and dogfoods the `getLiveState` fold the streams index
  // will use.
  #liveDemo: { count: number } = { count: 0 };
  // The project's streams index — a materialized view in the DO's own SQLite,
  // touched from the processEventBatch fan-in (see touchStreamActivity).
  readonly #streamDatabase = new StreamDatabase(this.ctx.storage.sql);
  // The agents roster — every agent stream's merged status record, fed from
  // the same fan-in (the status-changed patches ride the touch call).
  readonly #agentStatusDatabase = new AgentStatusDatabase(this.ctx.storage.sql);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });
  // This DO instance may host one connection's router stream
  // (/integrations/{slack,telegram}/{connection}): the name IS the connection,
  // for both routing and the bot-token secret path. Null (a non-connection
  // path) is passed through — a router processor errors loudly if a mis-armed
  // subscription ever wakes it there.
  readonly #integrationConnection = connectionFromIntegrationStreamPath(this.#name.path);
  readonly #registry = createStreamProcessorRegistry(this.ctx, {
    stream: this.#stream,
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
    // `itx.liveState` = the project's composite live state (see ProjectLiveState):
    // the processor's fold is ONE peer slice, alongside the streams index the DO
    // keeps in SQLite and the demo counter. The explicit return type breaks the
    // field-initializer inference cycle (this closure reads #projectReads,
    // which is built from this registry).
    getLiveState: (): ProjectLiveState => {
      const reduced = this.#projectReads.currentState;
      // Reconcile any catalog stream missing an index row (cheap when none are),
      // so newly-created quiet streams show up in ⌘K without waiting for events.
      this.#streamDatabase.seedMissing(reduced.streams);
      return {
        reduced,
        streamsIndex: this.#streamDatabase.all(),
        agents: this.#agentStatusDatabase.all(),
        liveDemo: this.#liveDemo,
      };
    },
  });
  // The DO constructs its processors — no host-injected readState/writeState/
  // keepAliveWhile deps; the runner owns durable progress and keepalive. NO
  // recovery on any of them, on purpose (parity with the host wiring): none
  // overrides `reconcile`, so no post-eviction pass would have work to settle.
  // Their consequential side effects all run under `blockProcessorWhile`,
  // which holds the frame — a death mid-work leaves the cursor behind and the
  // subscription spine redelivers. Their `runInBackground` work (the Slack 👀
  // ack, the create saga's search-index warm) is best-effort telemetry-grade
  // today and stays that way (see the registry module doc's recovery rule).
  readonly #projectProcessor = this.#registry.register(
    new ProjectProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      customDomains: createCloudflareProjectCustomDomainDeps({
        env: this.env,
        projectId: this.#name.projectId,
      }),
      itx: itxForScope({
        auth: trustedInternalAuthContext(),
        ctx: this.ctx,
        path: "/",
        projectId: this.#name.projectId,
      }),
    }),
  );
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (snapshots, egress rules, approval keys, live state)
  // must go through the runner's committed progress.
  readonly #projectReads = this.#registry.reads(this.#projectProcessor);

  // The Slack webhook router. It only ever WAKES on the Durable Object
  // instances addressed at `/integrations/slack/{connection}` (the host stream
  // is this DO's own path stream), where the OAuth connect flow configured
  // its subscription; registering it on every instance is harmless.
  // Registration is the point: the registry wakes the router by slug; nothing
  // dials the facet handle directly anymore (status is a journal fold).
  protected readonly slackRouterRegistration = this.#registry.register(
    new SlackProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      connection: this.#integrationConnection,
      acknowledgeRoutedWebhook: async ({ payload }) => {
        if (this.#integrationConnection === null) return;
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        try {
          await callProjectSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
            connection: this.#integrationConnection,
            method: "reactions.add",
            projectId: this.#name.projectId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The slack-agent processor adds the same reaction once the routed
          // stream catches up; whichever lands second dedups here.
          if (message.includes("already_reacted") || message.includes("not_reactable")) return;
          console.error("[slack] routed-webhook acknowledgement failed", {
            error,
            projectId: this.#name.projectId,
          });
        }
      },
    }),
  );

  // The Telegram webhook router — same hosting shape as the Slack router: it
  // only ever WAKES on `/integrations/telegram/{connection}` instances, where
  // connectTelegram configured its subscription. No routed-webhook ack dep:
  // Telegram has no reaction primitive; the telegram-agent processor's
  // "typing…" chat action covers acknowledgement.
  protected readonly telegramRouterRegistration = this.#registry.register(
    new TelegramProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      connection: this.#integrationConnection,
    }),
  );

  // The email thread router — same hosting shape as the Slack router: it only
  // ever WAKES on the Durable Object instance addressed at
  // `/integrations/email`, where project bootstrap (or the email ingress
  // door's belt-and-braces append) configured its subscription.
  readonly #emailProcessor = this.#registry.register(
    new EmailProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  readonly #emailReads = this.#registry.reads(this.#emailProcessor);

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#registry.wakeStreamSubscriber(args);
  }

  /** The registry's shared DO alarm (runner keepalives) — see stream-processor-registry.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#registry.handleAlarm(alarmInfo);
  }

  get emailProcessor() {
    // Runner-backed reads (#emailReads), never the processor instance — see
    // the #projectReads comment: instance reads are stale forever under
    // runner drive.
    return new StreamProcessorRpcTarget(this.#emailReads, {
      // The ingress door reads the sender allowlist from this snapshot; it
      // must reflect a policy event appended moments ago (e.g. the birth
      // seed) even when push delivery is lagging or a wake was dropped.
      catchUpBeforeSnapshot: () => this.#registry.catchUp(EmailProcessorContract.slug),
    });
  }

  describe() {
    return {
      projectId: this.#name.projectId,
      name: this.ctx.id.name!,
    };
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    // Runner-backed reads (#projectReads), never the processor instance —
    // see the field comment: instance reads are stale forever under runner
    // drive.
    return new StreamProcessorRpcTarget(this.#projectReads, {
      // Lists served from this snapshot (child streams, secrets) must reflect
      // a child stream created moments ago even when the root stream's push
      // delivery is lagging or a wake was dropped.
      catchUpBeforeSnapshot: () => this.#registry.catchUp(ProjectProcessorContract.slug),
    });
  }

  /** The project's live state — the get/set/assign/subscribe surface behind `itx.liveState`. */
  get liveState() {
    return new LiveStateRpcTarget(this.#registry);
  }

  /** Demo mutation: bump the shared counter and push it to every `itx.liveState` watcher. */
  incrementLiveDemo(): void {
    this.#liveDemo = { count: this.#liveDemo.count + 1 };
    this.#registry.refreshLive();
  }

  /**
   * Record stream activity in the index and push it to `itx.liveState`. Called
   * from the project's `processEventBatch` fan-in (every project-scoped
   * stream's events flow through it). Idempotent — `StreamDatabase.touch` only
   * advances recency — so a redelivered batch is harmless.
   */
  touchStreamActivity(input: TouchInput): void {
    this.#streamDatabase.touch(input);
    this.#registry.refreshLive();
  }

  /**
   * Fold a batch's agent status-changed patches into the agents roster and
   * push the change to `itx.liveState` watchers. Same envelope as
   * touchStreamActivity: called from the processEventBatch fan-in, idempotent
   * (event offsets guard redelivery), never load-bearing for delivery.
   */
  touchAgentStatus(input: AgentStatusTouchInput): void {
    this.#agentStatusDatabase.touch(input);
    this.#registry.refreshLive();
  }

  /**
   * Replace one roster row from the agent journal's full status-changed
   * history — the recovery lane for a dropped touch (merge patches cannot
   * reconstruct a lost field from later patches; the journal can). Returns
   * false when the snapshot lost a race with a newer touch and the caller
   * must re-read the journal. See AgentStatusDatabase.rebuild.
   */
  rebuildAgentStatus(input: AgentStatusTouchInput): boolean {
    const applied = this.#agentStatusDatabase.rebuild(input);
    if (applied) this.#registry.refreshLive();
    return applied;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#egressInterceptor !== undefined) {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressInterceptor.value(request);
    }
    return this.#egressWithApprovalGate(request);
  }

  /**
   * The human-approval gate in front of the egress lanes. Requests matching a
   * `hold` rule park HERE — the caller's fetch promise stays open — until a
   * grant/rejection lands on the project stream or the rule's timeout
   * auto-rejects. Everything the gate sees and records is placeholder form:
   * it runs before secret substitution, so approval events (and the approval
   * UI reading them) can honestly say "this request spends /secrets/x"
   * without material ever leaving the platform.
   */
  async #egressWithApprovalGate(request: Request): Promise<Response> {
    const rules = await this.#egressRules();
    if (rules.length === 0) return this.#egress(request);

    // Secret references also feed rule matching (match.secretPaths). If the
    // reference set is malformed we still match on method/host/path — a broken
    // getSecret placeholder must not be a way to slip a `deny`/`hold` rule —
    // just without the secret-path matchers. A request that then matches no
    // rule falls to the egress lanes, which report the canonical error.
    let secretPaths: string[] = [];
    try {
      secretPaths = secretReferencePathsFromRequest(request);
    } catch {
      secretPaths = [];
    }

    const rule = matchEgressRule(rules, { method: request.method, url: request.url, secretPaths });
    if (rule === undefined) return this.#egress(request);
    if (rule.verdict === "deny") {
      return approvalGateResponse({
        code: "egress_denied",
        detail: `Egress rule "${rule.ruleKey}" denies this request.`,
        ruleKey: rule.ruleKey,
      });
    }
    return this.#holdForHumanApproval({ request, rule, secretPaths });
  }

  /**
   * The project's egress rules, from reduced state with BOUNDED staleness:
   * push delivery normally keeps the fold current, but a wedged subscription
   * must not leave policy arbitrarily stale — so at most every 5s an egress
   * request pays one catch-up. (Grants are the trust boundary and always
   * catch up; rules are policy, where seconds of lag are acceptable.)
   */
  async #egressRules(): Promise<readonly EgressRule[]> {
    if (!this.#projectReads.isLoaded || Date.now() - this.#egressRulesFreshAt > 5_000) {
      await this.#registry.catchUp(ProjectProcessorContract.slug);
      this.#egressRulesFreshAt = Date.now();
    }
    return this.#projectReads.currentState.egressRules;
  }

  /**
   * Park one held request: append `human-approval-requested`, then live-tail
   * the project stream for a resolution referencing that event's offset (the
   * held request's identity — no minted ids). The wait is chunked so no
   * single cross-DO call stays open longer than ~25s; the deadline spans the
   * chunks. A Durable Object restart mid-hold fails the caller's fetch — the
   * requested event survives and the audit trail stays truthful, but the
   * MVP deliberately has no reconciler re-executing approved requests.
   */
  async #holdForHumanApproval(input: {
    request: Request;
    rule: EgressRule;
    secretPaths: string[];
  }): Promise<Response> {
    const { request, rule } = input;
    // ONE deadline drives both the `expiresAt` the approver UI reads and the
    // server's own hold — stamped now so they can't drift (body buffering and
    // the append below take time).
    const deadline = Date.now() + rule.approvalTimeoutMs;
    // Buffer the body up front: hashing consumes the stream, and the released
    // request is re-built from these bytes after the human answers.
    const bodyBytes = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
    const requestedPayload: HumanApprovalRequestedPayload = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      bodySha256: bodyBytes === null ? null : await sha256Hex(bodyBytes),
      bodyPreview: bodyBytes === null ? null : utf8Preview(bodyBytes),
      secretPaths: input.secretPaths,
      ruleKey: rule.ruleKey,
      expiresAt: new Date(deadline).toISOString(),
    };

    const stream = this.#stream;
    const [requested] = await stream.append({
      type: "events.iterate.com/project/human-approval-requested",
      payload: requestedPayload,
    });
    const approvalRequestEventOffset = requested!.offset;

    const resolution = await this.#awaitApprovalResolution({
      approvalRequestEventOffset,
      deadline,
      requestedPayload,
    });

    if (resolution === "expired") {
      await stream.append({
        type: "events.iterate.com/project/human-approval-rejected",
        idempotencyKey: `human-approval-expired:${approvalRequestEventOffset}`,
        payload: { approvalRequestEventOffset, reason: "expired" },
      });
      return approvalGateResponse({
        approvalRequestEventOffset,
        code: "approval_expired",
        detail: `No human answered within ${rule.approvalTimeoutMs}ms (rule "${rule.ruleKey}").`,
        ruleKey: rule.ruleKey,
      });
    }
    if (resolution === "rejected") {
      return approvalGateResponse({
        approvalRequestEventOffset,
        code: "approval_rejected",
        detail: `A human rejected this request (rule "${rule.ruleKey}").`,
        ruleKey: rule.ruleKey,
      });
    }

    // Granted: release the buffered request through the ordinary egress
    // lanes, then record what actually happened — approval and outcome are
    // separate facts.
    const released = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bodyBytes as BodyInit | null,
      redirect: request.redirect,
    });
    // Settling is bookkeeping about the outcome and must never CHANGE the
    // outcome: a failed append logs, but the caller still gets whatever
    // upstream truly returned (or the true upstream error).
    const settle = (payload: { status?: number; error?: string }) =>
      stream
        .append({
          type: "events.iterate.com/project/human-approval-settled",
          idempotencyKey: `human-approval-settled:${approvalRequestEventOffset}`,
          payload: { approvalRequestEventOffset, ...payload },
        })
        .catch((error: unknown) => {
          console.warn("egress approval: settle append failed", {
            approvalRequestEventOffset,
            error,
            projectId: this.#name.projectId,
          });
        });
    let response: Response;
    try {
      response = await this.#egress(released);
    } catch (error) {
      await settle({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await settle({ status: response.status });
    return response;
  }

  /**
   * Live-tail resolutions for one held request. Grants verify against the
   * enrolled key set: once ANY active approval key exists, an unsigned or
   * badly-signed grant is ignored (the hold keeps waiting) — deny stays
   * cheap, forging an approval requires the enrolled private key.
   */
  async #awaitApprovalResolution(input: {
    approvalRequestEventOffset: number;
    deadline: number;
    requestedPayload: HumanApprovalRequestedPayload;
  }): Promise<"granted" | "rejected" | "expired"> {
    const stream = this.#stream;
    const resolutionEventTypes = [
      "events.iterate.com/project/human-approval-granted",
      "events.iterate.com/project/human-approval-rejected",
    ];
    let cursor = input.approvalRequestEventOffset;

    // Live phase: chunked one-shot waits until the wall-clock deadline.
    while (Date.now() < input.deadline) {
      let event;
      try {
        event = await stream.waitForEvent({
          afterOffset: cursor,
          eventTypes: resolutionEventTypes,
          timeoutMs: Math.min(input.deadline - Date.now(), 25_000),
        });
      } catch (error) {
        // waitForEvent is a one-shot, not a durable waiter: chunk timeouts
        // (and transient stream restarts) just re-arm from the same cursor.
        if (
          error instanceof Error &&
          error.message.includes("Timed out waiting for stream event")
        ) {
          continue;
        }
        throw error;
      }
      cursor = event.offset;
      const verdict = await this.#judgeResolution(event, input);
      if (verdict !== null) return verdict;
    }

    // Expiry sweep: a verdict appended in the last chunk's shadow must still
    // win — a human who granted just in time is honored. Scan whole pages and
    // STOP at the first event created after the deadline, so other holds'
    // ongoing resolutions on a busy stream can't delay this expiry.
    while (true) {
      const page = await stream.getEvents({
        afterOffset: cursor,
        eventTypes: resolutionEventTypes,
      });
      if (page.length === 0) return "expired";
      for (const event of page) {
        if (Date.parse(event.createdAt) > input.deadline) return "expired";
        cursor = event.offset;
        const verdict = await this.#judgeResolution(event, input);
        if (verdict !== null) return verdict;
      }
    }
  }

  /**
   * Judge one resolution event for a specific held request: "rejected" for our
   * matching rejection, "granted" for a matching grant that passes signature
   * policy against FRESH key state, or null (not ours, or an ignored grant —
   * unsigned/bad-sig/catch-up-failed — which is never fatal to the hold).
   */
  async #judgeResolution(
    event: StreamEvent,
    input: {
      approvalRequestEventOffset: number;
      deadline: number;
      requestedPayload: HumanApprovalRequestedPayload;
    },
  ): Promise<"granted" | "rejected" | null> {
    if (event.type === "events.iterate.com/project/human-approval-rejected") {
      const rejection = HumanApprovalRejectedPayload.safeParse(event.payload);
      return rejection.success &&
        rejection.data.approvalRequestEventOffset === input.approvalRequestEventOffset
        ? "rejected"
        : null;
    }

    const grant = HumanApprovalGrantedPayload.safeParse(event.payload);
    if (
      !grant.success ||
      grant.data.approvalRequestEventOffset !== input.approvalRequestEventOffset
    ) {
      return null;
    }
    const message = buildApprovalMessage({
      projectId: this.#name.projectId,
      approvalRequestEventOffset: input.approvalRequestEventOffset,
      requested: input.requestedPayload,
      decision: "granted",
    });

    // A grant is judged exactly once at its offset — the resolution cursor
    // moves past it. So a transient key-state catch-up failure must NOT be
    // mistaken for a bad signature and silently drop a real human grant: retry
    // with backoff until the catch-up succeeds (then verify against FRESH keys)
    // or the hold's deadline passes — at which point it expires anyway, the
    // safe deny direction. A verdict that verifies but isn't accepted (unsigned,
    // bad signature, unknown/revoked key) is a real ignore, no retry.
    let backoffMs = 200;
    while (true) {
      try {
        await this.#registry.catchUp(ProjectProcessorContract.slug);
      } catch (error) {
        if (Date.now() >= input.deadline) {
          console.warn("egress approval: grant unverifiable — key-state catch-up kept failing", {
            approvalRequestEventOffset: input.approvalRequestEventOffset,
            keyId: grant.data.keyId,
            projectId: this.#name.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
        await this.#sleep(Math.min(backoffMs, input.deadline - Date.now(), 2_000));
        backoffMs *= 2;
        continue;
      }
      const verdict = await evaluateGrant({
        grant: grant.data,
        keys: this.#projectReads.currentState.humanApprovalKeys,
        message,
      });
      if (verdict.accepted) return "granted";
      console.warn("egress approval: grant ignored", {
        approvalRequestEventOffset: input.approvalRequestEventOffset,
        keyId: grant.data.keyId,
        projectId: this.#name.projectId,
        reason: verdict.reason,
      });
      return null;
    }
  }

  /** A cancellable-free delay for the catch-up backoff; clamps negatives to 0. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /** The egress lanes proper: platform references, secret substitution, bare fetch. */
  async #egress(request: Request): Promise<Response> {
    let secretPaths: string[];
    try {
      // Placeholders live in the request envelope: headers, or the URL for
      // providers that authenticate in the URL path (Telegram).
      secretPaths = secretReferencePathsFromRequest(request);
    } catch {
      return secretErrorResponse("secret_reference_required");
    }
    const platformReferences = platformReferencesFromHeaders(request.headers);

    // Platform API-key references (`getSecret({ platform: ... })`) resolve
    // HERE, from typed deployment config against a known origin-pinned
    // allowlist — no Durable Object, no synthetic secret. They do not mix
    // with project-secret references in one request.
    if (platformReferences.length > 0) {
      if (secretPaths.length > 0) return secretErrorResponse("secret_reference_foreign");
      try {
        const substituted = substitutePlatformApiKeyReferences({
          config: parseConfig(this.env),
          request,
        });
        return await withWebSocketHandshakeHeaders(
          request,
          await fetchWithCredentialRedirects(substituted, {
            assertUrlAllowed: (url) =>
              assertPlatformApiKeyReferencesAllowed(platformReferences, url),
          }),
        );
      } catch (error) {
        if (error instanceof SecretSubstitutionError) return secretErrorResponse(error.code);
        throw error;
      }
    }

    // One request, one secret: the referenced Secret DO substitutes its own
    // placeholders under its own host pin (cross-secret chaining is gone).
    if (secretPaths.length > 1) return secretErrorResponse("secret_reference_foreign");
    if (secretPaths.length === 1) {
      const response = await this.env.SECRET.getByName(
        DurableObjectNameCodec.stringify({
          projectId: this.#name.projectId,
          path: secretPaths[0]!,
        }),
      ).fetch(request);
      return withWebSocketHandshakeHeaders(request, response);
    }

    // Sandbox coding agents with no explicit project/platform secret use the
    // platform OpenAI key through AI Gateway. An explicit project secret wins,
    // including if a WebSocket client falls back to an HTTP POST, so credential
    // provenance and the secret audit cannot silently change between transports.
    if (isOpenAiPublicApiRequest(request)) {
      const routed = await this.#egressOpenAiViaAiGateway(request);
      if (routed !== null) return routed;
      // Fall through when accountId/gateway config is missing (local/dev edge).
    }

    return withWebSocketHandshakeHeaders(request, await fetch(request));
  }

  /**
   * Route JSON POST/PUT to `api.openai.com` through Cloudflare AI Gateway via
   * the Workers AI binding only (same door as agent BYOK). Returns null when
   * the request is not binding-shaped (GET, non-JSON, missing gateway) so
   * normal egress applies — no REST rewrite and no direct-OpenAI platform-key
   * ladder.
   */
  async #egressOpenAiViaAiGateway(request: Request): Promise<Response | null> {
    if (request.method !== "POST" && request.method !== "PUT") return null;

    const config = parseConfig(this.env);
    const routing = openAiAiGatewayRoutingFromConfig(config);
    if (routing === null) return null;

    const gateway = this.env.AI?.gateway?.(routing.gatewayId);
    if (gateway === undefined) return null;

    const endpoint = openAiGatewayBindingEndpoint(request.url);
    if (endpoint.replace(/\?.*$/, "").length === 0) return null;

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null;
    }

    const headers = openAiAiGatewayBindingHeaders({
      openaiApiKey: routing.openaiApiKey,
      projectId: this.#name.projectId,
      requestHeaders: request.headers,
    });
    await applyOpenAiAiGatewayCacheHeaders({
      headers,
      body,
      responseCacheTtlSeconds: routing.responseCacheTtlSeconds,
    });
    return gateway.run({
      provider: "openai",
      endpoint,
      headers,
      query: body,
    });
  }

  interceptEgress(handler: ProjectEgressInterceptor): ProjectEgressIntercept {
    if (typeof handler !== "function")
      throw new Error("project egress interceptor must be a function");
    const retained = deepRetainRpcStubs(handler);
    if (this.#egressInterceptor !== undefined) {
      console.warn("project egress interceptor overwritten", { projectId: this.#name.projectId });
      this.#egressInterceptor[Symbol.dispose]();
    }
    this.#egressInterceptor = retained;

    return new ProjectEgressInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#egressInterceptor !== retained) return;
        retained[Symbol.dispose]();
        this.#egressInterceptor = undefined;
      },
    });
  }
}

/** The approval gate's terminal responses: denied, rejected, or expired — never released. */
function approvalGateResponse(body: {
  approvalRequestEventOffset?: number;
  code: "egress_denied" | "approval_rejected" | "approval_expired";
  detail: string;
  ruleKey: string;
}): Response {
  return Response.json({ error: body.code, ...body }, { status: 403 });
}

/** First 2KB of a body as UTF-8 for the approval UI; null when it does not decode. */
function utf8Preview(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, 2048));
  } catch {
    return null;
  }
}
