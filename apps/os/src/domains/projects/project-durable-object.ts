import { DurableObject } from "cloudflare:workers";
import { LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import type { StreamEvent } from "iterate/processors";
import { trustedInternalAuthContext } from "../../auth.ts";
import { parseConfig } from "../../config.ts";
import { workerVersion, type Env } from "../../env.ts";
import {
  ProjectAiInterceptRpcTarget,
  ProjectEgressInterceptRpcTarget,
  StreamRpcTarget,
} from "../../rpc-targets.ts";
import {
  noAiInterceptorError,
  type ProjectAiIntercept,
  type ProjectAiInterceptor,
  type ProjectAiInterceptorInput,
} from "../../lib/model-interception.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { LiveStatePagers } from "../live-state-pager.ts";
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
import { isRetryableDurableObjectAvailabilityError } from "../streams/stream-unavailable.ts";
import type { ProjectEgressIntercept, ProjectEgressInterceptor } from "./egress.ts";
import {
  buildApprovalMessage,
  approvalRequestBody,
  evaluateDecision,
  matchEgressRule,
  sha256Hex,
  type EgressRule,
  type HeldRequest,
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
import {
  ProjectProcessorContract,
  type ProjectProcessorState,
} from "./project-processor-contract.ts";
import { StreamDatabase, type TouchInput } from "./stream-database.ts";
import type { ProjectLiveState } from "./project-live-state.ts";

export class ProjectDurableObject extends DurableObject<Env> {
  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  #egressInterceptor?: ReturnType<typeof deepRetainRpcStubs<ProjectEgressInterceptor>>;
  // The intercepted/* model lane's live handler slot (itx.ai.intercept) — same
  // last-writer-wins, session-bound semantics as the egress interceptor.
  #aiInterceptor?: ReturnType<typeof deepRetainRpcStubs<ProjectAiInterceptor>>;
  // Last time #egressRules paid a facade snapshot — bounds rules staleness to ~5s.
  #egressRulesFreshAt = 0;
  // Demo (stateful live state): a counter every watcher of `itx.liveState` sees
  // update, mutated by `itx.liveDemo.increment()`. Proves the DO-backed,
  // shared-engine case — and dogfoods the composite fold the streams index uses.
  #liveDemo: { count: number } = { count: 0 };
  // The project's streams index — a materialized view in the DO's own SQLite,
  // updated from the processEventBatch fan-in.
  readonly #streamDatabase = new StreamDatabase(this.ctx.storage.sql);
  readonly #stream = new StreamRpcTarget({
    auth: trustedInternalAuthContext(),
    path: this.#name.path,
    projectId: this.#name.projectId,
  });

  // ---------------------------------------------------------------------------
  // Reduced-state reads. The project processor runs as a facet of the root
  // stream's own Durable Object (src/domains/processor-facet-durable-object.ts); this DO mirrors its
  // committed fold through the stream's processor facade — one strict
  // catch-up-backed snapshot per refresh.
  // ---------------------------------------------------------------------------

  /** The latest reduced project state this incarnation fetched. */
  #lastReduced: ProjectProcessorState | undefined;

  async #processorFacade(): Promise<{
    snapshot(): Promise<{ offset: number; state: ProjectProcessorState }>;
  }> {
    // Safe: the root stream's facet composition registers the
    // ProjectProcessor under ProjectProcessorContract.slug on "/", so the
    // facade the Stream DO answers with for that name serves the project
    // contract's fold. The RPC-generated facade type is untyped per name
    // (the name is a runtime string), hence the assertion.
    return (await this.env.STREAM.getByName(
      DurableObjectNameCodec.stringify({ path: "/", projectId: this.#name.projectId }),
    ).processorFacade({ name: ProjectProcessorContract.slug })) as unknown as {
      snapshot(): Promise<{ offset: number; state: ProjectProcessorState }>;
    };
  }

  async #refreshReducedState(): Promise<ProjectProcessorState> {
    const { state } = await (await this.#processorFacade()).snapshot();
    this.#lastReduced = state;
    return state;
  }

  // ---------------------------------------------------------------------------
  // The composite live state: reduced fold ⊕ streams index ⊕ demo counter —
  // the shape behind `itx.liveState` (ProjectLiveState). The engine lives
  // here because two of its three slices are this DO's own storage.
  // ---------------------------------------------------------------------------

  readonly #liveState = new LiveState<ProjectLiveState>({
    reduced: ProjectProcessorContract.stateSchema.parse({}),
    streamsIndex: {},
    liveDemo: this.#liveDemo,
  });

  /** liveState watcher pagers (domains/live-state-pager.ts) — a watched
   * idle project hibernates at zero pin. Wired to the COMPOSITE engine above
   * (there is no processor registry here anymore — the project processor is
   * facet-hosted on the root stream): the flusher reads the engine's last
   * assembled state, and a pager seed refreshes through the same
   * `#loadAndRefreshLive` the RPC liveState node uses. */
  readonly #liveStatePagers = new LiveStatePagers({
    getWebSockets: (tag) => this.ctx.getWebSockets(tag),
    acceptWebSocket: (ws, tags) => this.ctx.acceptWebSocket(ws, tags),
    readState: () => this.#liveState.getState(),
    refresh: () => this.#loadAndRefreshLive(),
    waitUntil: (work) => this.ctx.waitUntil(work),
  });

  #assembleLive(): void {
    const reduced = this.#lastReduced;
    if (reduced === undefined) return;
    // Reconcile any catalog stream missing an index row (cheap when none are),
    // so newly-created quiet streams show up in ⌘K without waiting for events.
    this.#streamDatabase.seedMissing(reduced.streams);
    this.#liveState.setState({
      reduced,
      streamsIndex: this.#streamDatabase.all(),
      liveDemo: this.#liveDemo,
    });
    // Socket watchers hear about every assembly: the flusher re-reads the
    // engine at flush time, so scheduling here — the one materialization
    // point — is complete coverage.
    this.#liveStatePagers.scheduleFlush();
  }

  async #loadAndRefreshLive(): Promise<void> {
    await this.#refreshReducedState();
    this.#assembleLive();
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

  /** The project's live state — the get/set/assign/subscribe surface behind `itx.liveState`. */
  get liveState() {
    return new LiveStateRpcTarget<ProjectLiveState>({
      live: this.#liveState,
      loadAndRefreshLive: () => this.#loadAndRefreshLive(),
    });
  }

  /** Demo mutation: bump the shared counter and push it to every `itx.liveState` watcher. */
  async incrementLiveDemo(): Promise<void> {
    // Load the reduced peer slice before mutating so this update is published
    // immediately over real facts and a load failure rejects the caller.
    await this.#refreshReducedState();
    this.#liveDemo = { count: this.#liveDemo.count + 1 };
    this.#assembleLive();
  }

  /**
   * Update the live projections from one committed delivery before that
   * batch call returns. Both reducers are idempotent, so repeated calls
   * are harmless; a storage/RPC failure rejects the batch instead of silently
   * leaving live state stale. This fan-in is also what keeps the composite's
   * `reduced` slice fresh: every committed root-stream batch lands here.
   */
  async indexCommittedBatchFacts(input: { stream: TouchInput }): Promise<void> {
    this.#streamDatabase.touch(input.stream);
    // The reduced slice's refresh is a cross-DO snapshot now (the fold lives
    // in the root stream's facet); only pay it while someone is watching —
    // an engine subscriber (the pinning fallback path) or a socket watcher.
    if (this.#liveState.observed || this.#liveStatePagers.hasPagers()) {
      await this.#refreshReducedState();
      this.#assembleLive();
    }
  }

  async fetch(request: Request): Promise<Response> {
    // The liveState lane routes FIRST and never falls through on a bad token:
    // this same fetch serves egress requests whose headers user scripts
    // control, and a request wearing the internal header must not egress.
    const liveStateUpgrade = await this.#liveStatePagers.acceptUpgrade(request);
    if (liveStateUpgrade !== undefined) return liveStateUpgrade;
    const taken = takeStreamContext(request);
    if (this.#egressInterceptor !== undefined) {
      // Egress interceptors run before secret substitution. They must never
      // receive raw secret material, only getSecret(...) placeholders.
      return await this.#egressInterceptor.value(taken.request);
    }
    return this.#egressWithApprovalGate(taken.request, taken.streamContext);
  }

  /** Live State Pagers are one-way (this DO → relay); inbound frames are ignored. */
  webSocketMessage(): void {}

  /** A closed watcher socket simply drops off `getWebSockets`; nothing to clean up. */
  webSocketClose(): void {}

  webSocketError(_ws: WebSocket, error: unknown): void {
    this.#liveStatePagers.pagerError(error);
  }

  /**
   * The human-approval gate in front of the egress lanes. Requests matching a
   * `hold` rule park HERE — the caller's fetch promise stays open — batched
   * per (script run, rule), until a decision lands on the project stream or
   * the rule's timeout auto-rejects the batch. Everything the gate sees and
   * records is placeholder form: it runs before secret substitution, so
   * approval events (and the approval UI reading them) can honestly say
   * "this request spends /secrets/x" without material ever leaving the
   * platform.
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
   * at most every 5s an egress request pays one facade snapshot (a strict
   * catch-up-backed read of the facet-hosted fold). (Grants are the trust
   * boundary and always catch up; rules are policy, where seconds of lag are
   * acceptable.)
   */
  async #egressRules(): Promise<readonly EgressRule[]> {
    if (this.#lastReduced === undefined || Date.now() - this.#egressRulesFreshAt > 5_000) {
      await this.#refreshReducedState();
      this.#egressRulesFreshAt = Date.now();
    }
    return this.#lastReduced!.egressRules;
  }

  /**
   * Requests parked at the egress door but not yet committed as a batch: a
   * script run's concurrent burst at one hold rule coalesces here for the
   * rule's debounce window before ONE `human-approval-requested` event
   * records the whole batch. In-memory on purpose — the queued fetch
   * promises die with this Durable Object anyway, so a restart loses
   * nothing durable and strands nothing visible.
   */
  #pendingHoldBatches = new Map<string, PendingHoldBatch>();

  /**
   * Park one held request into its approval batch. Only a script run's
   * concurrent burst at one rule ever coalesces — anything without
   * script-execution provenance, or a rule with `debounceMs: null`, commits
   * immediately as a batch of one. The returned promise is the caller's
   * fetch outcome, resolved by {@link #flushHoldBatch} once a human (or the
   * expiry) decides the batch.
   */
  async #holdForHumanApproval(input: {
    request: Request;
    rule: EgressRule;
    secretPaths: string[];
    streamContext: StreamContext;
  }): Promise<Response> {
    const { request, rule } = input;
    // Buffer the body up front: hashing consumes the stream, and the released
    // request is re-built from these bytes after the human answers.
    const bodyBytes = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
    const entry: PendingHoldEntry = {
      bodyBytes,
      held: {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body:
          bodyBytes === null ? null : approvalRequestBody(bodyBytes, await sha256Hex(bodyBytes)),
        secretPaths: input.secretPaths,
      },
      redirect: request.redirect,
      resolve: () => {},
      reject: () => {},
    };
    const response = new Promise<Response>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    const executionId =
      input.streamContext.kind === "script-execution" ? input.streamContext.executionId : null;
    if (rule.debounceMs === null || executionId === null) {
      void this.#flushHoldBatch({
        entries: [entry],
        flushAtMs: Date.now(),
        opensAtMs: Date.now(),
        rule,
        streamContext: input.streamContext,
        timer: null,
      });
      return response;
    }

    // The dataloader: one pending batch per (script run, rule). Each arrival
    // extends the flush by one debounce window, capped from the batch's
    // opening so a drip-feed cannot postpone the human forever. Batches
    // never span rules, so mixed hold policies are structurally impossible.
    const batchKey = `${executionId}\u0000${rule.ruleKey}`;
    let batch = this.#pendingHoldBatches.get(batchKey);
    if (batch === undefined) {
      batch = {
        entries: [],
        flushAtMs: 0,
        opensAtMs: Date.now(),
        rule,
        streamContext: input.streamContext,
        timer: null,
      };
      this.#pendingHoldBatches.set(batchKey, batch);
    }
    batch.entries.push(entry);
    const flushAt = Math.min(
      Date.now() + rule.debounceMs,
      batch.opensAtMs + rule.debounceMs * HOLD_DEBOUNCE_CAP_FACTOR,
    );
    // A capped arrival cannot advance the fire time, so the armed timer
    // stands — without this, a sub-tick drip could keep replacing an
    // already-due timer and starve the flush.
    if (batch.timer !== null && flushAt <= batch.flushAtMs) return response;
    if (batch.timer !== null) clearTimeout(batch.timer);
    batch.flushAtMs = flushAt;
    const committed = batch;
    batch.timer = setTimeout(
      () => {
        this.#pendingHoldBatches.delete(batchKey);
        void this.#flushHoldBatch(committed);
      },
      Math.max(0, flushAt - Date.now()),
    );
    return response;
  }

  /**
   * Commit one batch and see it through: append the ONE
   * `human-approval-requested` event recording every held request, await the
   * decision (or expiry), then release / refuse each request per its
   * verdict. Every parked caller's promise is settled HERE — resolved with
   * its response, or rejected with the true failure — so this method itself
   * never throws.
   */
  async #flushHoldBatch(batch: PendingHoldBatch): Promise<void> {
    const { entries, rule } = batch;
    // ONE deadline drives both the `expiresAt` the approver UI reads and the
    // server's own hold — stamped at commit time so they can't drift.
    const deadline = Date.now() + rule.approvalTimeoutMs;
    const requestedPayload: HumanApprovalRequestedPayload = {
      requests: entries.map((held) => held.held),
      ruleKey: rule.ruleKey,
      ruleDescription: rule.description,
      streamContext: batch.streamContext,
      expiresAt: new Date(deadline).toISOString(),
    };
    try {
      const stream = this.#stream;
      const [requested] = await stream.append({
        type: "events.iterate.com/project/human-approval-requested",
        payload: requestedPayload,
      });
      const approvalRequestEventOffset = requested!.offset;

      const decision = await this.#awaitBatchDecision({
        approvalRequestEventOffset,
        deadline,
        requestedPayload,
      });

      if (decision === "expired") {
        await stream.append({
          type: "events.iterate.com/project/human-approval-decided",
          idempotencyKey: `human-approval-expired:${approvalRequestEventOffset}`,
          payload: {
            approvalRequestEventOffset,
            decidedBy: "expiry",
            verdicts: entries.map(() => "reject" as const),
          },
        });
        for (const entry of entries) {
          entry.resolve(
            approvalGateResponse({
              approvalRequestEventOffset,
              code: "approval_expired",
              deniedBy: "expiry",
              detail: `No human answered within ${rule.approvalTimeoutMs}ms (rule "${rule.ruleKey}").`,
              ruleKey: rule.ruleKey,
            }),
          );
        }
        return;
      }

      // Decided: rejected indexes refuse, approved indexes release through
      // the ordinary egress lanes CONCURRENTLY — they were concurrent when
      // the rule caught them. The settlement fact is part of each approved
      // entry's success: its caller cannot observe success unless that fact
      // landed durably, while a failure still stays isolated from siblings.
      await Promise.all(
        entries.map(async (entry, index) => {
          if (decision.verdicts[index] === "reject") {
            entry.resolve(
              approvalGateResponse({
                approvalRequestEventOffset,
                code: "approval_rejected",
                deniedBy: "human",
                // The human's stated reason rides the 403 body verbatim so
                // the calling script/agent reads WHY and can retry changed.
                reason: decision.reason,
                detail:
                  `A human rejected this request (rule "${rule.ruleKey}")` +
                  (decision.reason === undefined ? "." : `: ${decision.reason}`),
                ruleKey: rule.ruleKey,
              }),
            );
            return;
          }
          const settle = (outcome: { status?: number; error?: string }) =>
            stream.append({
              type: "events.iterate.com/project/human-approval-settled",
              idempotencyKey: `human-approval-settled:${approvalRequestEventOffset}:${index}`,
              payload: { approvalRequestEventOffset, index, ...outcome },
            });
          // Every per-entry failure (including Request reconstruction and
          // settlement journaling) rejects THAT entry inside this callback.
          // The fan-out Promise.all must never reject, or the outer catch
          // would blast pending siblings while their upstream calls run on.
          let response: Response;
          try {
            const released = new Request(entry.held.url, {
              method: entry.held.method,
              headers: entry.held.headers,
              body: entry.bodyBytes as BodyInit | null,
              redirect: entry.redirect,
            });
            response = await this.#egress(released);
          } catch (error) {
            try {
              await settle({ error: error instanceof Error ? error.message : String(error) });
              entry.reject(error);
            } catch (settlementError) {
              entry.reject(settlementError);
            }
            return;
          }

          try {
            await settle({ status: response.status });
            entry.resolve(response);
          } catch (error) {
            entry.reject(error);
          }
        }),
      );
    } catch (error) {
      // A failure before the verdicts fanned out (the requested append, the
      // decision wait) fails every parked caller with the true error.
      for (const entry of entries) entry.reject(error);
    }
  }

  /**
   * Live-tail the ONE decided event for a batch. Decisions verify against
   * the enrolled key set: once ANY active approval key exists, an unsigned
   * or badly-signed approval is ignored (the hold keeps waiting) — deny
   * stays cheap, forging an approval requires the enrolled private key.
   */
  async #awaitBatchDecision(input: {
    approvalRequestEventOffset: number;
    deadline: number;
    requestedPayload: HumanApprovalRequestedPayload;
  }): Promise<AcceptedBatchDecision | "expired"> {
    const stream = this.#stream;
    const resolutionEventTypes = ["events.iterate.com/project/human-approval-decided"];
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
      const decision = await this.#judgeDecision(event, input);
      if (decision !== null) return decision;
    }

    // Expiry sweep: a decision appended in the last chunk's shadow must still
    // win — a human who answered just in time is honored. Scan whole pages and
    // STOP at the first event created after the deadline, so other batches'
    // ongoing decisions on a busy stream can't delay this expiry.
    while (true) {
      const page = await stream.getEvents({
        afterOffset: cursor,
        eventTypes: resolutionEventTypes,
      });
      if (page.length === 0) return "expired";
      for (const event of page) {
        if (Date.parse(event.createdAt) > input.deadline) return "expired";
        cursor = event.offset;
        const decision = await this.#judgeDecision(event, input);
        if (decision !== null) return decision;
      }
    }
  }

  /**
   * Judge one decided event for a specific batch: its verdicts (plus the
   * human's rejection reason) when it references this batch and passes
   * signature policy against FRESH key state, or null (not ours, or an
   * ignored decision — malformed/unsigned/bad-sig/catch-up-failed — which is
   * never fatal to the hold).
   */
  async #judgeDecision(
    event: StreamEvent,
    input: {
      approvalRequestEventOffset: number;
      deadline: number;
      requestedPayload: HumanApprovalRequestedPayload;
    },
  ): Promise<AcceptedBatchDecision | null> {
    const decided = ProjectProcessorContract.events[
      "events.iterate.com/project/human-approval-decided"
    ].payloadSchema.safeParse(event.payload);
    if (
      !decided.success ||
      decided.data.approvalRequestEventOffset !== input.approvalRequestEventOffset
    ) {
      return null;
    }
    // A verdict per request or nothing: acting on a short/long verdict list
    // would silently decide requests its signer never saw.
    if (decided.data.verdicts.length !== input.requestedPayload.requests.length) {
      console.warn("egress approval: decision ignored — verdict count mismatch", {
        approvalRequestEventOffset: input.approvalRequestEventOffset,
        expected: input.requestedPayload.requests.length,
        got: decided.data.verdicts.length,
        projectId: this.#name.projectId,
      });
      return null;
    }
    const message = buildApprovalMessage({
      projectId: this.#name.projectId,
      approvalRequestEventOffset: input.approvalRequestEventOffset,
      requests: input.requestedPayload.requests,
      verdicts: decided.data.verdicts,
    });

    // A decision is judged exactly once at its offset — the resolution cursor
    // moves past it. So a transient key-state catch-up failure must NOT be
    // mistaken for a bad signature and silently drop a real human approval:
    // retry with backoff until the catch-up succeeds (then verify against
    // FRESH keys) or the hold's deadline passes — at which point it expires
    // anyway, the safe deny direction. A decision that verifies but isn't
    // accepted (unsigned, bad signature, unknown/revoked key) is a real
    // ignore, no retry.
    let backoffMs = 200;
    while (true) {
      let keyState: ProjectProcessorState;
      try {
        keyState = await this.#refreshReducedState();
      } catch (error) {
        if (Date.now() >= input.deadline) {
          console.warn("egress approval: decision unverifiable — key-state catch-up kept failing", {
            approvalRequestEventOffset: input.approvalRequestEventOffset,
            keyId: decided.data.keyId,
            projectId: this.#name.projectId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
        await this.#sleep(Math.min(backoffMs, input.deadline - Date.now(), 2_000));
        backoffMs *= 2;
        continue;
      }
      const verdict = await evaluateDecision({
        decision: decided.data,
        keys: keyState.humanApprovalKeys,
        message,
      });
      if (verdict.accepted) {
        return { verdicts: decided.data.verdicts, reason: decided.data.reason };
      }
      console.warn("egress approval: decision ignored", {
        approvalRequestEventOffset: input.approvalRequestEventOffset,
        keyId: decided.data.keyId,
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

  interceptAi(handler: ProjectAiInterceptor): ProjectAiIntercept {
    if (typeof handler !== "function") throw new Error("project AI interceptor must be a function");
    const retained = deepRetainRpcStubs(handler);
    if (this.#aiInterceptor !== undefined) {
      console.warn("project AI interceptor overwritten", { projectId: this.#name.projectId });
      this.#aiInterceptor[Symbol.dispose]();
    }
    this.#aiInterceptor = retained;

    return new ProjectAiInterceptRpcTarget({
      ctx: this.ctx,
      release: () => {
        if (this.#aiInterceptor !== retained) return;
        retained[Symbol.dispose]();
        this.#aiInterceptor = undefined;
      },
    });
  }

  /**
   * Serve one intercepted/* model invocation through the live AI interceptor. Both
   * egress paths (`itx.ai.run` in the isolate, agent turns in the processor
   * facet) land here, so the handler slot and its last-writer-wins story live
   * in exactly one place. No interceptor → the canonical loud error; the
   * caller's own failure lane (recorded attempt failure, RPC rejection)
   * carries it from there.
   */
  async consultAiInterceptor(input: ProjectAiInterceptorInput): Promise<unknown> {
    const interceptor = this.#aiInterceptor;
    if (interceptor === undefined) throw noAiInterceptorError(input.model);
    return await interceptor.value(input);
  }
}

/** The approval gate's terminal responses: denied, rejected, or expired — never released. */
function approvalGateResponse(body: {
  approvalRequestEventOffset?: number;
  code: "egress_denied" | "approval_rejected" | "approval_expired";
  /** Who refused a held batch: a human's decision, or the door's timeout. */
  deniedBy?: "human" | "expiry";
  /** The human's stated rejection reason, verbatim — what the calling agent reads. */
  reason?: string;
  detail: string;
  ruleKey: string;
}): Response {
  return Response.json({ error: body.code, ...body }, { status: 403 });
}

/** The FIRST accepted decision's substance: a verdict per index, plus the
 * human's rejection reason when one was given. */
type AcceptedBatchDecision = {
  verdicts: readonly ("approve" | "reject")[];
  reason: string | undefined;
};

/** One parked caller inside a pending batch: its buffered request, its
 * placeholder-form record for the event, and the promise handles its fetch
 * outcome settles through. */
type PendingHoldEntry = {
  bodyBytes: Uint8Array | null;
  held: HeldRequest;
  redirect: RequestRedirect;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
};

/** One un-committed approval batch: the entries of one script run's burst at
 * one rule, plus the debounce timer that will flush them as ONE
 * `human-approval-requested` event. */
type PendingHoldBatch = {
  entries: PendingHoldEntry[];
  /** When the armed timer will fire. An arrival only reschedules by ADVANCING
   * this; once the cap is the fire time, the armed timer stands untouched, so
   * the cap holds structurally rather than by event-loop ordering. */
  flushAtMs: number;
  opensAtMs: number;
  rule: EgressRule;
  streamContext: StreamContext;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Total debounce wait is capped at this multiple of the rule's debounceMs,
 * however steadily new requests keep extending the window. */
const HOLD_DEBOUNCE_CAP_FACTOR = 3;
