import { DurableObject } from "cloudflare:workers";
import { LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { createStreamProcessorRegistry } from "iterate/processors/cloudflare";
import type { StreamSubscriberWakeRequest, StreamSubscriberWakeResponse } from "iterate/processors";
import type { StreamEvent } from "iterate/processors";
import { trustedInternalAuthContext } from "../../auth.ts";
import { parseConfig } from "../../config.ts";
import { workerVersion, type Env } from "../../env.ts";
import {
  itxForScope,
  ProjectEgressInterceptRpcTarget,
  StreamProcessorRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
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
  SECRET_JSON_TEMPLATE_HEADER,
  SecretSubstitutionError,
} from "../secrets/utils.ts";
import { SlackProcessor } from "../integrations/slack-processor-implementation.ts";
import { SlackProcessorContract } from "../integrations/slack-processor-contract.ts";
import { eyesReactionTargetFromWebhookPayload } from "../integrations/slack-agent-processor-implementation.ts";
import { callProjectSlackWebApi } from "../integrations/slack-api.ts";
import { TelegramProcessor } from "../integrations/telegram-processor-implementation.ts";
import { TelegramProcessorContract } from "../integrations/telegram-processor-contract.ts";
import { callProjectTelegramBotApi } from "../integrations/telegram-api.ts";
import { buildTelegramAccessSettingsUrl } from "../integrations/utils.ts";
import { readProjectById } from "../../project-directory.ts";
import { EmailProcessor } from "../email/email-processor-implementation.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { NotificationProcessor } from "../notifications/notification-processor-implementation.ts";
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import { defaultProjectWorkerRef } from "../repos/utils.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import type { ProjectEgressIntercept, ProjectEgressInterceptor } from "./egress.ts";
import {
  buildApprovalMessage,
  approvalRequestBody,
  evaluateGrant,
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
import { takeStreamContext, type StreamContext } from "./stream-context.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { ProjectProcessor } from "./project-processor-implementation.ts";
import { StreamDatabase, type TouchInput } from "./stream-database.ts";
import type { ProjectLiveState } from "./project-live-state.ts";
import { createCloudflareProjectCustomDomainDeps } from "./custom-domains.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

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
  // updated from the processEventBatch fan-in.
  readonly #streamDatabase = new StreamDatabase(this.ctx.storage.sql);
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
  // ack) is best-effort telemetry-grade
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
        streamContext: { kind: "scope", scopePath: "/" },
        path: "/",
        projectId: this.#name.projectId,
      }),
      workerFetch: (request) =>
        new DynamicWorkerRunner({
          streamContext: { kind: "scope", scopePath: "/" },
          exports: this.ctx.exports,
          projectId: this.#name.projectId,
          scopePath: "/",
        }).fetch({
          ref: defaultProjectWorkerRef(),
          request,
          traceRole: "project_config",
        }),
    }),
  );
  readonly #notificationProcessor = this.#registry.register(
    new NotificationProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
  );
  readonly #notificationReads = this.#registry.reads(this.#notificationProcessor);
  // Runner-backed reads: under runner drive the runner owns the cursors and
  // the processor instance's internal checkpoint never advances, so every
  // read this DO serves (snapshots, egress rules, approval keys, live state)
  // must go through the runner's committed progress.
  readonly #projectReads = this.#registry.reads(this.#projectProcessor);

  // The Slack webhook router. It only ever WAKES on the Durable Object
  // instances addressed at `/integrations/slack/{connection}` (the host stream
  // is this DO's own path stream), where the OAuth connect flow configured
  // its subscription; registering it on every instance is harmless.
  // Registration routes wake delivery by slug; #slackReads below exposes the
  // same runner's committed fold to the public processor inspection handle.
  protected readonly slackRouterRegistration = this.#registry.register(
    new SlackProcessor({
      stream: this.#stream,
      path: this.#name.path,
      projectId: this.#name.projectId,
      acknowledgeRoutedWebhook: async ({ connection, payload }) => {
        const ack = eyesReactionTargetFromWebhookPayload(payload);
        if (ack == null) return;
        try {
          await callProjectSlackWebApi({
            body: { channel: ack.channel, name: "eyes", timestamp: ack.timestamp },
            connection,
            method: "reactions.add",
            projectId: this.#name.projectId,
            streamContext: { kind: "scope", scopePath: this.#name.path },
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
  readonly #slackReads = this.#registry.reads(this.slackRouterRegistration);

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
      now: Date.now,
      sendTelegramMessage: ({ body, connection }) =>
        callProjectTelegramBotApi({
          body,
          connection,
          method: "sendMessage",
          projectId: this.#name.projectId,
          streamContext: { kind: "scope", scopePath: this.#name.path },
        }),
      telegramAccessSettingsUrl: async ({ connection, projectId }) => {
        const project = await readProjectById(this.env.PROJECT_DIRECTORY, projectId);
        if (project === null) {
          throw new Error(
            `Telegram access denial cannot link project ${projectId}: directory record missing`,
          );
        }
        return buildTelegramAccessSettingsUrl({
          baseUrl: parseConfig(this.env).baseUrl || "https://os.iterate.com",
          connection,
          projectSlug: project.slug,
        });
      },
    }),
  );
  readonly #telegramReads = this.#registry.reads(this.telegramRouterRegistration);

  // The email thread router — same hosting shape as the Slack router: it only
  // ever WAKES on the Durable Object instance addressed at
  // `/integrations/email`, where project bootstrap explicitly created it and
  // configured its subscription. Email ingress only appends received mail.
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

  get slackProcessor() {
    return new StreamProcessorRpcTarget(this.#slackReads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(SlackProcessorContract.slug),
    });
  }

  get telegramProcessor() {
    return new StreamProcessorRpcTarget(this.#telegramReads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp(TelegramProcessorContract.slug),
    });
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

  get notificationProcessor() {
    return new StreamProcessorRpcTarget(this.#notificationReads, {
      catchUpBeforeSnapshot: () => this.#registry.catchUp("notification"),
    });
  }

  /** The project's live state — the get/set/assign/subscribe surface behind `itx.liveState`. */
  get liveState() {
    return new LiveStateRpcTarget(this.#registry);
  }

  /** Demo mutation: bump the shared counter and push it to every `itx.liveState` watcher. */
  async incrementLiveDemo(): Promise<void> {
    // External live-state inputs cannot use the synchronous refresh door on a
    // cold incarnation: it deliberately refuses to assemble from a runner's
    // schema default. Load every peer before mutating so this update is
    // published immediately and a load failure rejects the caller.
    await this.#registry.loadAndRefreshLive();
    this.#liveDemo = { count: this.#liveDemo.count + 1 };
    this.#registry.refreshLive();
  }

  /**
   * Update the live projections from one committed delivery before that
   * delivery is acknowledged. Both reducers are idempotent, so spine retries
   * are harmless; a storage/RPC failure rejects the batch instead of silently
   * leaving live state stale.
   */
  async indexCommittedBatchFacts(input: { stream: TouchInput }): Promise<void> {
    // See incrementLiveDemo: once this resolves every peer slice is real, so
    // the synchronous refresh below cannot drop this external index update.
    await this.#registry.loadAndRefreshLive();
    const streamsBefore = this.#streamDatabase.all();
    this.#streamDatabase.touch(input.stream);
    if (streamsBefore !== this.#streamDatabase.all()) {
      this.#registry.refreshLive();
    }
  }

  async fetch(request: Request): Promise<Response> {
    const taken = takeStreamContext(request);
    if (this.#egressInterceptor !== undefined) {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressInterceptor.value(taken.request);
    }
    return this.#egressWithApprovalGate(taken.request, taken.streamContext);
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
  async #egressWithApprovalGate(request: Request, streamContext: StreamContext): Promise<Response> {
    const rules = await this.#egressRules();
    if (rules.length === 0) return this.#egress(request);

    // Secret references also feed rule matching (match.secretPaths). If the
    // reference set is malformed we still match on method/host/path — a broken
    // getSecret placeholder must not be a way to slip a `deny`/`hold` rule —
    // just without the secret-path matchers. A request that then matches no
    // rule falls to the egress lanes, which report the canonical error.
    const scanned = await secretReferencePathsFromRequest(request);
    const secretPaths = scanned.problems.length === 0 ? scanned.paths : [];

    const rule = matchEgressRule(rules, { method: request.method, url: request.url, secretPaths });
    if (rule === undefined) return this.#egress(request);
    if (rule.verdict === "deny") {
      return approvalGateResponse({
        code: "egress_denied",
        detail: `Egress rule "${rule.ruleKey}" denies this request.`,
        ruleKey: rule.ruleKey,
      });
    }
    if (scanned.problems[0] !== undefined) return this.#egress(request);
    return this.#holdForHumanApproval({ request, rule, secretPaths, streamContext });
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
    streamContext: StreamContext;
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
      body: bodyBytes === null ? null : approvalRequestBody(bodyBytes, await sha256Hex(bodyBytes)),
      secretPaths: input.secretPaths,
      ruleKey: rule.ruleKey,
      ruleDescription: rule.description,
      streamContext: input.streamContext,
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
    let availabilityBackoffMs = 200;
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
        // just re-arm from the same cursor.
        if (
          error instanceof Error &&
          error.message.includes("Timed out waiting for stream event")
        ) {
          continue;
        }
        // A hold spans minutes of human latency, so the stream DO behind the
        // wait WILL sometimes restart mid-chunk (connection recycle, eviction,
        // deploy reset, explicit kill). By the stream-unavailable contract
        // those rejections are retryable — the incarnation reboots on the next
        // call and durable resolutions replay from the cursor — so re-arm
        // instead of failing the parked fetch (which killed whole script runs:
        // tasks/script-runs-survive-parked-egress-holds.md). Backoff keeps a
        // hard-down stream from hot-looping; the deadline still bounds the
        // hold, and expiry remains the safe direction.
        if (isRetryableDurableObjectAvailabilityError(error)) {
          await this.#sleep(Math.min(availabilityBackoffMs, input.deadline - Date.now()));
          availabilityBackoffMs = Math.min(availabilityBackoffMs * 2, 5_000);
          continue;
        }
        throw error;
      }
      availabilityBackoffMs = 200;
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
      const rejection = ProjectProcessorContract.events[
        "events.iterate.com/project/human-approval-rejected"
      ].payloadSchema.safeParse(event.payload);
      return rejection.success &&
        rejection.data.approvalRequestEventOffset === input.approvalRequestEventOffset
        ? "rejected"
        : null;
    }

    const grant = ProjectProcessorContract.events[
      "events.iterate.com/project/human-approval-granted"
    ].payloadSchema.safeParse(event.payload);
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
    // Placeholders live in the request envelope: headers, the URL path, or an
    // explicitly marked JSON body.
    const { paths: secretPaths, problems } = await secretReferencePathsFromRequest(request);
    if (problems[0] !== undefined) return secretErrorResponse(problems[0].code);
    const platformReferences = platformReferencesFromHeaders(request.headers);
    if (request.headers.has(SECRET_JSON_TEMPLATE_HEADER) && secretPaths.length === 0) {
      return secretErrorResponse("secret_reference_required");
    }

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
