import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ProcessorState, ReduceArgs, StreamEvent } from "iterate/processors";
import type { ItxExpression } from "../../itx/expression.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { Project } from "../../itx-api.generated.ts";
import type { ScriptExecutionCheck } from "../typecheck/virtual-project.ts";
import type { StreamContext } from "../projects/stream-context.ts";
import type { JsonValue } from "../workers/schemas.ts";
import type {
  CapabilityProvidedPayload,
  CapabilityRecord,
  ProvideCapabilityInput,
  RevokeCapabilityInput,
  SetPreambleInput,
} from "./types.ts";
import {
  assemblePreamble,
  retainedScriptResult,
  RETAINED_SCRIPT_RESULTS_LIMIT,
  type AssembledPreamble,
} from "./capability-host-preamble.ts";
import { assertCapabilityPath, sameCapabilityPath } from "./capability-path.ts";
import { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { settleByDeadline } from "./execution-deadline.ts";
import {
  SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS,
  ScriptExecutionSettlement,
  scriptCompletionInput,
  settlementAppendDeadline,
  settlementForUndrivenScript,
  settlementFromWorkerOutcome,
  type ScriptExecutionSettlement as ScriptExecutionSettlementValue,
} from "./script-execution-settlement.ts";
import {
  evaluateItxExpression,
  invokeNormalizedCapability,
  normalizeCapabilityProvider,
} from "./itx-expression.ts";

/**
 * The capability-host processor: one scope's dynamic capability table plus its
 * script-run obligations, both reduced from the scope's stream.
 *
 * HOW IT WORKS, end to end:
 *
 * The stream carries two families of facts. CAPABILITY facts
 * (`capability-provided` / `capability-revoked`) reduce into the durable mount
 * table: one row per mount path, a re-provide at the same path replaces the
 * row, and a mount's identity is `providedAtOffset` — the stream offset of the
 * event that created it, no synthetic mount ids anywhere. The itx-facing verbs
 * on this class (`provideCapability`, `revokeCapability`, `invokeCapability`,
 * `describeCapabilities`) are the scope's public capability surface:
 * mounting appends the fact and then waits for its own delivery
 * (read-your-writes), reads resolve the longest matching prefix over the
 * reduced table, and a local miss follows the birth certificate's `fallback`
 * expression — ONE direct hop, usually to the project root host, re-evaluated
 * against this scope's own itx on every read so the stream stores the NAME of
 * the fallback and never captured authority.
 *
 * SCRIPT facts are a promise vocabulary. `script-run-requested` opens an
 * obligation, keyed by the caller-supplied `executionId` (the requester lives
 * on ANOTHER stream — an agent stream, a public runScript call — so this
 * stream's offsets cannot name the obligation for it; the id is the
 * cross-stream correlation key and every settle idempotency key derives from
 * it). `script-run-started` is durable evidence that an attempt began,
 * appended BEFORE the script body runs — so requested-without-started provably
 * never ran, while started-without-settled may have half-executed.
 * `script-run-settled` is the ONE terminal fact; reducing it deletes the
 * obligation. Entries carry the code, so an attempt can start from reduced
 * state alone — recovery never re-reads the request event.
 *
 * The at-head pass in `processEvent` (under `delivery.caughtUp`) compares the
 * open obligations in state against `#liveExecutions` — the script runs alive
 * in THIS incarnation — and for every obligation nobody here is driving it
 * either STARTS it (status `requested` and unexpired: typecheck gate → started
 * evidence → worker RPC → settled, all in one background attempt) or SETTLES
 * it: expired before any attempt began, or `started` with no live run — the
 * incarnation running it died, so it settles as an orphan FAILURE and is NEVER
 * re-run (a script may have half-executed non-idempotent side effects; the
 * agent renders the failure and the model decides whether to retry).
 *
 * RECOVERY rides that same at-head pass. When an incarnation dies owing script
 * work, the keepalive alarm revives the processor and appends
 * `events.iterate.com/stream/processor-revived`; its wake produces the
 * eventless at-head pass that re-drives the open obligations — fresh requested
 * scripts start, orphaned started scripts settle. Starting fresh and
 * recovering after an eviction are the same code path. The pass is
 * BLOCKED (one outer `blockProcessorWhile` per at-head pass): a settle append
 * that fails keeps the frame retryable, so the transport's redelivery — not a
 * timer — is what retries a transiently failed settlement. Settle appends are
 * idempotency-keyed on the executionId alone, so a zombie incarnation racing
 * its replacement collapses to one settled fact; a loser reads back the
 * durable outcome and stands down (`#appendSettlementsWithin`).
 */
export class CapabilityHostProcessor extends StreamProcessor<
  CapabilityHostProcessorContract,
  CapabilityHostProcessorDeps
> {
  readonly contract = CapabilityHostProcessorContract;

  /** Script executions alive in THIS incarnation — the "actually running" half
   * the at-head pass compares the reduced obligations against. */
  readonly #liveExecutions = new Set<string>();

  /**
   * Exact outcomes already known by this incarnation but not yet observed back
   * from the stream. A timed-out settle append is an ambiguous transport
   * outcome, not permission to replace the script's real result with an
   * invented orphan classification: the at-head pass retries this same
   * settlement under the settle idempotency key until the durable event
   * reduces (or the incarnation itself disappears).
   */
  readonly #pendingSettlements = new Map<string, ScriptExecutionSettlementValue>();

  // ------------------------------------------------------------ processEvent
  // Synchronous; one switch over the delivered event, then the state-derived
  // work at head. This processor has exactly ONE per-event effect (observing
  // its own settled facts back); everything else it does is derived from the
  // reduced state once the delivery is caught up.
  protected override processEvent(
    args: ProcessEventArgs<CapabilityHostProcessorContract>,
  ): undefined {
    const { event, state, delivery, blockProcessorWhile } = args;

    switch (event?.type) {
      case "events.iterate.com/capability-host/script-run-settled":
        // The durable settlement came back through our own subscription: this
        // incarnation no longer owes its retry.
        this.#pendingSettlements.delete(event.payload.executionId);
        break;
      // created / capability-provided / capability-revoked /
      // script-run-requested / script-run-started: no per-event side effect —
      // they matter through the reduced state below.
    }

    // ---------------------------------------- state-derived side effects
    // Only at head: behind it the state is a partial reduction and a script's
    // settled fact may sit in stream pages not yet replayed — acting early
    // would re-run a settled script.
    if (!delivery.caughtUp) return;
    if (!state.birthCertificate) return;
    // ONE outer blocking closure per at-head pass — a nested
    // blockProcessorWhile would register after the runner's per-event blocker
    // snapshot and never be awaited. Blocking (not background) is deliberate:
    // holding the frame keeps a failed settle append retryable via the
    // transport's redelivery; a dropped background attempt would strand the
    // obligation until something else happened to wake the stream.
    blockProcessorWhile(() => this.#startOrSettleOpenScriptRuns(args));
  }

  /**
   * The at-head pass over the open script obligations: for every entry in
   * `state.scriptExecutions` that no run in THIS incarnation is driving,
   * either start it or settle it.
   *
   * - a settlement this incarnation already knows (`#pendingSettlements`) is
   *   re-appended verbatim — never reclassified;
   * - `requested` and unexpired → start the attempt in the background (the
   *   whole typecheck → started → worker → settled pipeline);
   * - anything else — expired before an attempt, or `started` with its
   *   incarnation gone — settles via {@link settlementForUndrivenScript}: an
   *   orphaned `started` script is a FAILURE and is never re-run, because the
   *   body may have half-executed and scripts are not assumed idempotent.
   *
   * Recovery is this same code: the platform's revived fact (appended after an
   * eviction took in-flight work) is consumed by the contract purely so its
   * ordinary delivery lands at head and runs this pass.
   */
  async #startOrSettleOpenScriptRuns(
    args: ProcessEventArgs<CapabilityHostProcessorContract>,
  ): Promise<void> {
    const now = this.#now();
    const settle: {
      executionId: string;
      expiresAt: number;
      reason: "pending-settlement" | "recovery";
      settlement: ScriptExecutionSettlementValue;
    }[] = [];
    for (const [executionId, execution] of Object.entries(args.state.scriptExecutions)) {
      if (this.#liveExecutions.has(executionId)) continue;
      const pendingSettlement = this.#pendingSettlements.get(executionId);
      if (pendingSettlement) {
        settle.push({
          executionId,
          expiresAt: execution.expiresAt,
          reason: "pending-settlement",
          settlement: pendingSettlement,
        });
        continue;
      }
      if (execution.status === "requested" && now < execution.expiresAt) {
        this.#liveExecutions.add(executionId);
        // The head state handed to this pass, NOT an instance read: the
        // typecheck gate must see capabilities provided in the same delivery
        // as the request or it would judge the script against a stale scope.
        // The preamble is assembled from the same head state for the same
        // reason — a result settled or an entry set in this delivery must be
        // visible to the script this delivery starts.
        const capabilities = args.state.capabilities;
        const fallback = args.state.birthCertificate?.fallback ?? null;
        const preamble = assemblePreamble({
          entries: args.state.preamble,
          results: args.state.settledScriptResults,
        });
        args.runInBackground(() =>
          this.#executeScript({
            capabilities,
            code: execution.code,
            executionId,
            expiresAt: execution.expiresAt,
            fallback,
            preamble,
            requestedAtOffset: execution.requestedAtOffset,
          }),
        );
        continue;
      }
      settle.push({
        executionId,
        expiresAt: execution.expiresAt,
        reason: "recovery",
        settlement: settlementForUndrivenScript(execution.status),
      });
    }
    // Settle inline — this runs inside the head event's outer blocking closure
    // (see processEvent), so awaiting the single atomic append holds the frame.
    if (!settle.length) return;
    for (const { executionId, reason, settlement } of settle) {
      if (reason !== "recovery") continue;
      console.info("[capability-host] recovering undriven script execution", {
        cancellation: settlement.status === "failed" ? settlement.cancellation : undefined,
        executionId,
        failureKind: settlement.status === "failed" ? settlement.failureKind : undefined,
        phase: settlement.status === "failed" ? settlement.phase : undefined,
        status: settlement.status,
      });
    }
    // One stream append is both faster and stronger than serial appends: a
    // recovery backlog consumes one bounded settlement window and commits
    // every orphan classification atomically in canonical execution order.
    await this.#appendSettlementsWithin(settle);
  }

  // ------------------------------------------------------------------ reduce
  // Pure reduction, one switch, cases inline.
  protected override reduce({ event, state }: ReduceArgs<CapabilityHostProcessorContract>) {
    // A COPIED event is data delivered from another stream, never this scope's
    // own lifecycle: reducing one would fabricate local state — e.g. the
    // clients-to-root subscription copies client scopes' provider Pager
    // connected/disconnected facts onto "/" for the project catalog, and the
    // root host reducing those would grow phantom pager entries keyed by copy
    // offsets that no real disconnect can ever clear (or worse, a source
    // offset colliding with a real root pager's would clear the real one).
    if (event.source?.copiedFrom) return state;
    switch (event.type) {
      case "events.iterate.com/capability-host/created":
        // The first created event wins; a duplicate is a no-op (explicit
        // creation rejects conflicting births at the append door — a throwing
        // reducer would only wedge the frame).
        if (state.birthCertificate) return state;
        return { ...state, birthCertificate: event.payload };
      case "events.iterate.com/capability-host/capability-provider-pager-connected":
        return {
          ...state,
          capabilityProviderPagers: [
            ...state.capabilityProviderPagers,
            { connectedAtOffset: event.offset },
          ],
        };
      case "events.iterate.com/capability-host/capability-provider-pager-disconnected":
        return {
          ...state,
          capabilityProviderPagers: state.capabilityProviderPagers.filter(
            (pager) => pager.connectedAtOffset !== event.payload.connectedAtOffset,
          ),
          capabilities: state.capabilities.filter(
            (capability) =>
              capability.type !== "live" ||
              capability.providerPager.connectedAtOffset !== event.payload.connectedAtOffset,
          ),
        };
      case "events.iterate.com/capability-host/capability-provided": {
        const row: CapabilityRecord = {
          ...event.payload,
          // The stream offset is the mount's identity. It is stable,
          // observable, and already exists because the append IS the commit
          // point for a mount. Handles use it to revoke exactly the mount
          // they received, without a second generated id.
          providedAtOffset: event.offset,
        };
        const exists = state.capabilities.some((capability) =>
          sameCapabilityPath(capability.path, row.path),
        );
        return {
          ...state,
          capabilities: exists
            ? state.capabilities.map((capability) =>
                sameCapabilityPath(capability.path, row.path) ? row : capability,
              )
            : [...state.capabilities, row],
        };
      }
      case "events.iterate.com/capability-host/capability-revoked": {
        const revoke = event.payload;
        return {
          ...state,
          capabilities: state.capabilities.filter((capability) => {
            if (!sameCapabilityPath(capability.path, revoke.path)) return true;
            // With providedAtOffset the revoke names ONE exact mount: a path
            // re-mounted since then keeps its newer row.
            return (
              Number.isFinite(revoke.providedAtOffset) &&
              capability.providedAtOffset !== revoke.providedAtOffset
            );
          }),
        };
      }
      case "events.iterate.com/capability-host/script-run-requested":
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.executionId]: {
              status: "requested" as const,
              code: event.payload.code,
              requestedAtOffset: event.offset,
              expiresAt: event.payload.expiresAt,
            },
          },
        };
      case "events.iterate.com/capability-host/script-run-started": {
        const existing = state.scriptExecutions[event.payload.executionId];
        // A started fact for an already-settled (deleted) obligation reduces
        // to nothing — the settle won.
        if (!existing) return state;
        return {
          ...state,
          scriptExecutions: {
            ...state.scriptExecutions,
            [event.payload.executionId]: { ...existing, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        const scriptExecutions = { ...state.scriptExecutions };
        delete scriptExecutions[event.payload.executionId];
        // Retain the outcome for the preamble's derived `results` array —
        // classification (inline JSON vs inferred-type-plus-loader vs error)
        // is pure and deterministic, so replays reduce identically. The
        // settlement event stays the only durable storage of full payloads.
        const retained = retainedScriptResult({
          executionId: event.payload.executionId,
          settledAtOffset: event.offset,
          settlement: event.payload.settlement,
        });
        return {
          ...state,
          scriptExecutions,
          ...(!retained
            ? {}
            : {
                settledScriptResults: [...state.settledScriptResults, retained].slice(
                  -RETAINED_SCRIPT_RESULTS_LIMIT,
                ),
              }),
        };
      }
      case "events.iterate.com/capability-host/preamble-set": {
        const { key, code } = event.payload;
        const exists = state.preamble.some((entry) => entry.key === key);
        return {
          ...state,
          preamble: exists
            ? // A re-set updates code in place: injection order is first-set
              // order, so entries that reference each other stay stable.
              state.preamble.map((entry) => (entry.key === key ? { ...entry, code } : entry))
            : [...state.preamble, { key, code, setAtOffset: event.offset }],
        };
      }
      case "events.iterate.com/capability-host/preamble-removed":
        return {
          ...state,
          preamble: state.preamble.filter((entry) => entry.key !== event.payload.key),
        };
      default:
        return state;
    }
  }

  // -------------------------------------------------------- itx-facing verbs
  // The scope's public capability surface, called via the hosting durable
  // object (never by the delivery loop).

  async connectCapabilityProviderPager(options: {
    afterAppend(connectedAtOffset: number): void | Promise<void>;
  }): Promise<number> {
    await this.#assertCreated();
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/capability-provider-pager-connected",
      payload: {},
    });
    await options.afterAppend(committed.offset);
    await this.deps.reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
    return committed.offset;
  }

  async disconnectCapabilityProviderPager(connectedAtOffset: number): Promise<void> {
    await this.#assertCreated();
    const { state } = await this.deps.reads.snapshot();
    if (
      !state.capabilityProviderPagers.some((pager) => pager.connectedAtOffset === connectedAtOffset)
    ) {
      return;
    }
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/capability-provider-pager-disconnected",
      payload: { connectedAtOffset },
    });
    await this.deps.reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  async provideCapability(
    input: CapabilityProvidedPayload,
    options: {
      afterAppend?(record: CapabilityRecord): void | Promise<void>;
    } = {},
  ) {
    await this.#assertCreated();
    const prepared = await this.#prepareCapabilityRecord(input);
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/capability-provided",
      payload: prepared,
    });
    const provision = { path: prepared.path, providedAtOffset: committed.offset };
    const record = { ...prepared, providedAtOffset: committed.offset } satisfies CapabilityRecord;

    try {
      await options.afterAppend?.(record);
      await this.deps.reads.waitUntilEvent({
        offset: committed.offset,
        timeoutMs: INGEST_WAIT_TIMEOUT_MS,
      });
      return provision;
    } catch (provideError) {
      // The provide event is already durable. Roll back this exact offset so
      // a failed call cannot leave an ownerless mount behind. Exact identity
      // also prevents the cleanup from revoking a later replacement.
      try {
        const [rolledBack] = await this.append({
          type: "events.iterate.com/capability-host/capability-revoked",
          payload: provision,
        });
        await this.deps.reads.waitUntilEvent({
          offset: rolledBack.offset,
          timeoutMs: INGEST_WAIT_TIMEOUT_MS,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [provideError, rollbackError],
          `capability "${prepared.path.join(".")}" provide and exact rollback failed`,
        );
      }
      throw provideError;
    }
  }

  async revokeCapability({ path, providedAtOffset }: RevokeCapabilityInput) {
    await this.#assertCreated();
    assertCapabilityPath(path);
    const { state } = await this.deps.reads.snapshot();
    const current = state.capabilities.find((record) => sameCapabilityPath(record.path, path));
    if (Number.isFinite(providedAtOffset) && current?.providedAtOffset !== providedAtOffset) {
      return;
    }
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/capability-revoked",
      payload: {
        path,
        ...(!Number.isFinite(providedAtOffset) ? {} : { providedAtOffset }),
      },
    });
    await this.deps.reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  /**
   * Upsert one preamble entry — TypeScript injected above every later script
   * in this scope. Mirrors provideCapability's shape: validate cheaply, gate
   * expensively (the set-time compile), append the fact, then wait for its
   * own delivery (read-your-writes). The compile gate compares the scope's
   * assembled preamble WITH and WITHOUT the candidate and rejects only
   * problems the candidate introduces — a stale older entry (or a prior
   * result whose inferred type stopped compiling) must not veto an unrelated
   * set, just as it never blocks a script.
   */
  async setPreamble(input: SetPreambleInput): Promise<void> {
    await this.#assertCreated();
    if (typeof input.key !== "string" || !input.key.length) {
      throw new Error('setPreamble requires a non-empty string "key"');
    }
    if (typeof input.code !== "string") {
      throw new Error('setPreamble requires string "code" — TypeScript statements to inject');
    }
    const checkPreamble = this.deps.checkPreamble;
    if (checkPreamble) {
      const { state } = await this.deps.reads.snapshot();
      const withCandidate = assemblePreamble({
        entries: upsertPreambleEntry(state.preamble, input),
        results: state.settledScriptResults,
      });
      if (withCandidate) {
        const capabilities = await this.#describeCapabilitiesFrom(
          state.capabilities,
          state.birthCertificate?.fallback ?? null,
        );
        const problems = await checkPreamble({ capabilities, preamble: withCandidate.ts });
        if (problems.length) {
          const without = assemblePreamble({
            entries: state.preamble.filter((entry) => entry.key !== input.key),
            results: state.settledScriptResults,
          });
          // The with/without diff keys on the problem MINUS its position: a
          // re-set that changes an earlier entry's line count shifts every
          // stale error's `preamble:N`, and a position-sensitive diff would
          // read those same old problems as newly introduced. Counted as a
          // MULTISET, not a set: a candidate adding a second occurrence of an
          // already-stale message is still introducing a problem.
          const preexisting = new Map<string, number>();
          for (const problem of !without
            ? []
            : await checkPreamble({ capabilities, preamble: without.ts }).catch(() => [])) {
            const key = positionlessProblem(problem);
            preexisting.set(key, (preexisting.get(key) || 0) + 1);
          }
          const introduced = problems.filter((problem) => {
            const key = positionlessProblem(problem);
            const remaining = preexisting.get(key) || 0;
            if (remaining === 0) return true;
            preexisting.set(key, remaining - 1);
            return false;
          });
          if (introduced.length) {
            throw new Error(
              `preamble entry "${input.key}" does not compile:\n${introduced.join("\n")}`,
            );
          }
        }
      }
    }
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/preamble-set",
      payload: { key: input.key, code: input.code },
    });
    await this.deps.reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  /** Remove one preamble entry by key; unknown keys are a durable no-op. */
  async removePreamble(input: { key: string }): Promise<void> {
    await this.#assertCreated();
    if (typeof input.key !== "string" || !input.key.length) {
      throw new Error('removePreamble requires a non-empty string "key"');
    }
    const [committed] = await this.append({
      type: "events.iterate.com/capability-host/preamble-removed",
      payload: { key: input.key },
    });
    await this.deps.reads.waitUntilEvent({
      offset: committed.offset,
      timeoutMs: INGEST_WAIT_TIMEOUT_MS,
    });
  }

  /**
   * The scope's current assembled preamble — the exact text injected above
   * the next script (the derived `results` array plus user entries) and the
   * raw entry table. Null when there is nothing to inject. Deliberately no
   * #assertCreated, matching describeCapabilities: reading an unborn scope
   * reports empty rather than erroring discovery paths.
   */
  async describePreamble(): Promise<{
    text: string;
    entries: { key: string; code: string }[];
  } | null> {
    const { state } = await this.deps.reads.snapshot();
    const assembled = assemblePreamble({
      entries: state.preamble,
      results: state.settledScriptResults,
    });
    if (!assembled) return null;
    return {
      text: assembled.ts,
      entries: state.preamble.map(({ key, code }) => ({ key, code })),
    };
  }

  /**
   * Read one settled script result back from the scope stream — the durable
   * storage behind every `results[N].load(itx)` loader in the preamble (large
   * results retain only their inferred type in state). Point read by the
   * settle idempotency key, so it works for any retained-or-not execution
   * that ever settled in this scope.
   */
  async getScriptResult(executionId: string): Promise<{ executionId: string; data: JsonValue }> {
    await this.#assertCreated();
    const event = await this.stream.getEvent({
      idempotencyKey: `capability-host/script-run-settled@${executionId}`,
    });
    const settlement = settlementFromSettledEvent(event, executionId);
    if (!settlement) {
      throw new Error(`no settled script execution "${executionId}" in scope ${this.#scopePath}`);
    }
    if (settlement.status === "failed") {
      throw new Error(`script execution "${executionId}" failed: ${settlement.error}`);
    }
    return { executionId, data: settlement.result ?? null };
  }

  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    // A trailing __describe is a valid INVOCATION (answered from the mount's
    // durable metadata below) — the reserved-name rule is for MOUNT names, so
    // validate the path without it or discovery on provided capabilities dies
    // here with "invalid capability path segment".
    assertCapabilityPath(path[path.length - 1] === "__describe" ? path.slice(0, -1) : path);
    const { state } = await this.deps.reads.snapshot();
    if (!state.birthCertificate) {
      throw new Error(`capability host at ${this.#scopePath} has not been created`);
    }
    const hit = resolveLongestPrefix(state.capabilities, path);
    if (!hit) {
      // Not declared at THIS scope: follow the birth certificate's recorded
      // fallback — ONE direct hop, usually to the project root host. This is
      // how an agent sees capabilities mounted on the project. Resolution
      // reads live state every call, so a revoked local mount transparently
      // re-exposes whatever the fallback host has at that path.
      const fallback = await this.#fallbackHost(state.birthCertificate.fallback);
      if (fallback) return await fallback.invokeCapability({ args, path });
      throw new Error(`no capability "${path.join(".")}"`);
    }
    // `__describe` on a mounted capability is answered HERE, from the mount's
    // durable metadata (instructions/types recorded at provide time) — the
    // live target is never dialed, for ANY mount kind. Flattened mounts
    // especially: forwarding ["...","__describe"] to a flattenNestedPaths
    // target would hand a discovery probe to a dispatcher that treats every
    // path as a method route. This is what makes discovery work on
    // Pager-backed live mounts whose provider is offline, and it is the first
    // rung of the transitive-description ladder.
    if (path[path.length - 1] === "__describe") {
      return this.#describeMount(hit.record, path.slice(0, -1));
    }
    if (hit.record.type === "itx-call") {
      const evaluated = await evaluateItxExpression(this.deps.itx, hit.record.expression);
      const provider = await normalizeCapabilityProvider(evaluated, hit.record);
      return await invokeNormalizedCapability(provider, hit.rest, args);
    }
    if (!this.deps.invokeLiveCapability) {
      // Live mounts are Pager-bound: the durable record outlives the
      // provider's Pager, and a call while it is away fails plainly. (A
      // dedicated receiver-absent signal that PARKS a stream delivery
      // instead of failing it is future work — see
      // docs/stream-subscription-model-redesign.md.)
      throw new Error(`capability "${hit.record.path.join(".")}" is offline`);
    }
    return await this.deps.invokeLiveCapability(hit.record, hit.rest, args);
  }

  // Reports everything reachable at this scope: this scope's own mounts plus
  // everything the fallback host reports, each tagged with the scope it was
  // declared at. A local mount shadows a fallback one at the same path (same
  // rule as `resolveLongestPrefix` below), so the caller — usually an LLM
  // deciding what it can invoke — sees exactly one entry per reachable path
  // and where it lives.
  async describeCapabilities(): Promise<CapabilityDescription[]> {
    const { state } = await this.deps.reads.snapshot();
    // Deliberately no #assertCreated: describing an unborn scope reports []
    // (discovery stays safe everywhere), while invoking one throws above.
    return await this.#describeCapabilitiesFrom(
      state.capabilities,
      state.birthCertificate?.fallback ?? null,
    );
  }

  // ------------------------------------------------------- private machinery

  async #assertCreated(): Promise<void> {
    const { state } = await this.deps.reads.snapshot();
    if (!state.birthCertificate) {
      throw new Error(`capability host at ${this.#scopePath} has not been created`);
    }
  }

  async #prepareCapabilityRecord(
    input: CapabilityProvidedPayload,
  ): Promise<CapabilityProvidedPayload> {
    const { path } = input;
    const inputType: unknown = input.type;
    assertCapabilityPath(path);
    let record: CapabilityProvidedPayload;
    if (input.type === "live") {
      const flattenNestedPath = input.flattenNestedPaths === true;
      record = {
        flattenNestedPaths: flattenNestedPath ? true : undefined,
        instructions: input.instructions,
        path,
        providerPager: input.providerPager,
        type: "live",
        types: input.types,
      };
    } else if (input.type === "itx-call") {
      if (!Array.isArray(input.expression)) {
        throw new Error(
          '"expression" must be an ARRAY of steps — property names and [method, ...args] calls ' +
            'walked over itx, e.g. ["streams", ["get", "/"]] — not JavaScript source. ' +
            'Copy the recipe from itx.docs.get({ name: "typed-capability-mount" }).',
        );
      }
      assertExpressionDoesNotReferenceOwnMount(input);
      record = {
        expression: input.expression,
        flattenNestedPaths: input.flattenNestedPaths === true ? true : undefined,
        instructions: input.instructions,
        path,
        type: "itx-call",
        types: input.types ?? (await this.#selfDescribedTypes(input.expression)),
      };
    } else {
      input satisfies never;
      throw new Error(`unsupported capability input ${String(inputType)}`);
    }
    // Authored types must compile before they enter the stream — a typo'd
    // declaration rejected here is a fixable error; one recorded durably is
    // silent rot every docs read and typecheck inherits. This runs AFTER the
    // cheap structural checks above so a malformed payload never costs a
    // network-bound compile before its real error surfaces.
    if (input.types) {
      const problems = (await this.deps.validateCapabilityTypes?.(input.types)) ?? [];
      if (problems.length) {
        throw new Error(
          `capability "types" for "${path.join(".")}" does not compile:\n${problems.join("\n")}`,
        );
      }
    }
    return record;
  }

  /**
   * Connect-time auto-typing: a durable expression mount provided WITHOUT
   * types asks the capability to describe itself ONCE, here, and keeps the
   * `types` its `__describe()` reports — the MCP and OpenAPI connect doors
   * generate theirs from tool schemas and spec operations, so third-party
   * services become as documented as builtins with zero author effort.
   * Best-effort by design: an unreachable or slow server, a target without
   * `__describe`, or self-reported types that fail to compile all leave the
   * mount untyped rather than blocking the provide. The compile gate keeps
   * the invariant that types recorded THROUGH provideCapability always
   * compile (direct `capability-provided` appends — agent birth mounts,
   * userspace processors — bypass this method entirely).
   */
  async #selfDescribedTypes(
    expression: Extract<ProvideCapabilityInput, { type: "itx-call" }>["expression"],
  ): Promise<string | undefined> {
    // The catch rides the promise itself, BEFORE the race: describing may
    // lose to the deadline and fail later, and an abandoned rejection must
    // not surface as unhandled after the provide already returned.
    const described = this.#describeExpressionTypes(expression).catch(() => undefined);
    // The deadline keeps a hanging third-party server (MCP listTools, an
    // OpenAPI spec fetch) from hanging the provide — past it, the mount just
    // stays untyped.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        described,
        new Promise<undefined>((resolve) => {
          deadline = setTimeout(() => resolve(undefined), 10_000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }

  async #describeExpressionTypes(
    expression: Extract<ProvideCapabilityInput, { type: "itx-call" }>["expression"],
  ): Promise<string | undefined> {
    const evaluated = await evaluateItxExpression(this.deps.itx, expression);
    const value = (await evaluated.value) as {
      __describe?: () => Promise<{ types?: string }>;
    };
    const types = (await value.__describe?.())?.types;
    if (typeof types !== "string" || !types.length) return undefined;
    const problems = (await this.deps.validateCapabilityTypes?.(types)) ?? [];
    return !problems.length ? types : undefined;
  }

  /**
   * The `Description` for one mount, built entirely from the durable record.
   * `at` is the path the caller asked about (which may be nested below the
   * mount point). Besides the provider's own instructions/types, the prose
   * explains HOW dispatch works for this mount kind — most usefully for
   * `flattenNestedPaths` targets, which are dispatchers rather than object
   * graphs: their sub-paths cannot be enumerated, only routed.
   */
  #describeMount(record: CapabilityRecord, at: string[]) {
    const mountPoint = record.path.join(".");
    const asked = at.join(".");
    const nestedNote =
      at.length > record.path.length
        ? ` You asked about the nested path "${asked}" — nesting below the mount is ${record.flattenNestedPaths === true ? "routed, not enumerable: only the provider knows which sub-paths exist" : "resolved by property traversal on the provider's value"}.`
        : "";
    const dispatch =
      record.flattenNestedPaths === true
        ? `This is a FLATTENED dispatch target: any dotted call under the mount compiles to one invokeCapability call with the remaining path — \`${mountPoint}.a.b(x)\` reaches the provider as \`invokeCapability({ path: ["a","b"], args: [x] })\`. There is no object graph to walk; \`children\` is empty because sub-paths are routes the provider interprets, not members this host can list.`
        : record.type === "live"
          ? `Dotted calls under the mount replay onto the provider's value by property traversal (\`${mountPoint}.a.b(x)\` calls \`a.b(x)\` on it). Live mounts are Pager-backed: the client gives the host a hibernatable return channel so it can Page the provider relay after releasing ordinary RPC references. The mount record is durable, but calls fail with "offline" when that Pager disconnects. \`children\` is empty because the host only stores this record, never the provider's shape.`
          : `A durable itx-expression: on every call the recorded expression is re-evaluated against this scope's own itx and the remaining path is invoked on the result — no live connection is held. \`children\` is empty because the host only stores the recipe, not the evaluated value's shape.`;
    return {
      instructions: [
        record.instructions ?? `A dynamic ${record.type} capability mounted at "${mountPoint}".`,
        dispatch + nestedNote,
      ].join("\n\n"),
      // __describe is the identity card, never big: a giant declaration
      // (authors can record hundreds of KB) is truncated here; the budgeted
      // reader is `itx.docs.get({ name: "<mount path>", maxTokens })`.
      types: truncatedTypes(record.types ?? "", mountPoint),
      children: {},
      parent: `the capability host at scope "${this.#scopePath}" (mounted at "${mountPoint}", providedAtOffset ${record.providedAtOffset})`,
    };
  }

  /**
   * The birth certificate's fallback expression, evaluated against this
   * scope's own itx into the host reads fall back to — or null when the
   * certificate ends resolution here (the project root, and every unborn or
   * pre-fallback host). Evaluated per read: the stream stores the NAME of
   * the fallback, never a captured handle. Platform-written expressions
   * evaluate to an in-process RpcTarget (never a disposable client stub), so
   * the hop holds nothing that needs disposal.
   */
  async #fallbackHost(
    fallback: ItxExpression | null | undefined,
  ): Promise<FallbackCapabilityHost | null> {
    if (!fallback) return null;
    const { value } = await evaluateItxExpression(this.deps.itx, fallback);
    if (!isFallbackCapabilityHost(value)) {
      throw new Error(
        `capability fallback expression for scope ${this.#scopePath} did not evaluate to a capability host`,
      );
    }
    // Platform-written fallbacks always point at "/", but the field is stream
    // data: reject the one trivially-expressible cycle instead of letting a
    // self-pointing scope recurse through DO dials to the subrequest limit.
    if (typeof value.path === "string" && normalizePath(value.path) === this.#scopePath) {
      throw new Error(`capability fallback for scope ${this.#scopePath} points at itself`);
    }
    return value;
  }

  async #describeCapabilitiesFrom(
    records: CapabilityRecord[],
    fallbackExpression: ItxExpression | null | undefined,
  ): Promise<CapabilityDescription[]> {
    const local: CapabilityDescription[] = records.map((record) => ({
      instructions: record.instructions,
      path: record.path,
      providedAtOffset: record.providedAtOffset,
      scope: this.#scopePath,
      type: record.type,
      types: record.types,
    }));
    const fallback = await this.#fallbackHost(fallbackExpression);
    if (!fallback) return local;
    const shadowed = new Set(local.map((c) => JSON.stringify(c.path)));
    const { capabilities: inherited } = await fallback.__describe();
    return [...local, ...inherited.filter((c) => !shadowed.has(JSON.stringify(c.path)))];
  }

  /**
   * The pre-execution typecheck gate: a script whose OWN code carries a
   * provable error (a syntax error, a near-miss typo the compiler can name
   * the fix for) settles as an error settlement without running — the model
   * reads compiler errors instead of paying a failed run. Permissive
   * everywhere the checker lacks knowledge (unknown types, unchecked
   * verdicts, checker failures): the gate may only ever block on proof.
   * Returns the settlement error, or null to proceed.
   */
  async #typecheckScriptForRun(
    code: string,
    records: CapabilityRecord[],
    fallback: ItxExpression | null,
    preamble: AssembledPreamble | null,
  ): Promise<{ rejection: string | null; emittedJs?: string }> {
    const typecheckScript = this.deps.typecheckScript;
    if (!typecheckScript) return { rejection: null };
    try {
      const capabilities = await this.#describeCapabilitiesFrom(records, fallback);
      const checked = await typecheckScript({ capabilities, code, preamble: preamble?.ts });
      if (checked.verdict === "clean") {
        // Check and emit are one compile: what runs IS the compiler's
        // type-stripped output, so scripts are genuinely TypeScript.
        return { rejection: null, emittedJs: checked.emittedJs };
      }
      if (checked.verdict !== "problems") return { rejection: null };
      return {
        rejection: [
          "Script was NOT executed: it does not typecheck against this scope's capability types.",
          ...checked.problems,
          "Fix the type errors and resend the whole corrected script.",
        ].join("\n"),
      };
    } catch (error) {
      // The gate must never fail a script for the checker's own failure — an
      // unreachable sidecar or a fallback-host dial error means unchecked.
      console.warn("[capability-host] script typecheck skipped", { error });
      return { rejection: null };
    }
  }

  /**
   * One attempt at one script obligation, start to settled — background work:
   * it can run for minutes, and the stream (not this closure) is what survives
   * an eviction. Typecheck gate → started evidence → worker RPC → settled,
   * with the deadline enforced at every stage.
   */
  async #executeScript(input: {
    capabilities: CapabilityRecord[];
    code: string;
    executionId: string;
    expiresAt: number;
    fallback: ItxExpression | null;
    preamble: AssembledPreamble | null;
    requestedAtOffset: number;
  }) {
    const now = () => this.#now();
    const executionExpiresAt = input.expiresAt - SCRIPT_EXECUTION_SETTLEMENT_GRACE_MS;
    try {
      // The typecheck gate runs BEFORE the started evidence: it has no side
      // effects, so a rejected script provably never ran (requested →
      // settled, no started event) and the orphan policy is untouched.
      const checkedOutcome = await settleByDeadline(
        this.#typecheckScriptForRun(input.code, input.capabilities, input.fallback, input.preamble),
        executionExpiresAt,
        now,
      );
      if (checkedOutcome.status === "deadline") {
        await this.#appendSettlementWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error:
                "Script execution reached its absolute deadline while being typechecked. It never ran.",
              failureKind: "deadline",
              phase: "typecheck",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }
      if (checkedOutcome.status === "rejected") throw checkedOutcome.error;
      const checked = checkedOutcome.value;
      if (checked.rejection) {
        await this.#appendSettlementWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error: checked.rejection,
              failureKind: "typecheck",
              phase: "typecheck",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }
      // Started-evidence lands durably BEFORE the script body runs, so the
      // reduced state can always tell "provably never ran" (requested,
      // startable late) from "may have half-run" (started, settle-only).
      // Deliberately OUTSIDE the try below: if this append fails the script
      // never ran, so no settlement may be appended — the obligation stays
      // `requested`, the rethrow marks the keepalive window failed, and a
      // later at-head pass retries the whole attempt.
      await this.#awaitAppendWithin(
        this.append({
          type: "events.iterate.com/capability-host/script-run-started",
          idempotencyKey: this.idempotencyKey(`script-run-started@${input.executionId}`),
          payload: { executionId: input.executionId },
        }),
        executionExpiresAt,
        `record the start of script execution "${input.executionId}"`,
      );
      if (now() >= executionExpiresAt) {
        await this.#appendSettlementWithin(
          {
            executionId: input.executionId,
            settlement: {
              status: "failed",
              error:
                "Script execution reached its absolute deadline after its start was recorded but before the worker was invoked. It never ran.",
              failureKind: "deadline",
              phase: "before-execution",
              executionMayHaveOccurred: false,
              cancellation: "not-applicable",
            },
          },
          input.expiresAt,
        );
        return;
      }

      // The entrypoint owns a timer around the dynamic-worker invocation, but
      // the RPC carrying that result back to this host is a second failure
      // boundary. Bound it independently: a half-open worker stub must not
      // keep the obligation (and its stream-native public waiter) alive forever
      // even if the remote timer fired correctly.
      const runPromise = this.deps.scriptExecutionEntrypoint.run(input.code, {
        emittedJs: checked.emittedJs,
        expiresAt: executionExpiresAt,
        preambleJs: input.preamble?.js,
        streamContext: {
          kind: "script-execution",
          streamPath: this.#scopePath,
          scriptRunRequestedEventOffset: input.requestedAtOffset,
          executionId: input.executionId,
        },
      });
      const runOutcome = await settleByDeadline(runPromise, executionExpiresAt, now);
      if (runOutcome.status === "deadline") {
        // Workers RPC promises are disposable capabilities at runtime. End
        // this host's retained call as soon as its absolute wait expires;
        // the durable settlement still conservatively says arbitrary
        // external work may continue because disposal is not a cancellation
        // acknowledgement from code the script already invoked.
        (runPromise as Promise<unknown> & Partial<Disposable>)[Symbol.dispose]?.();
      }
      const settlement = settlementFromWorkerOutcome(runOutcome);
      // Deliberately outside the worker-invocation catch: a failed stream
      // append must never be reclassified as a script runtime failure. It
      // rejects this tracked attempt, and the next at-head pass retries the
      // same idempotent settlement.
      await this.#appendSettlementWithin(
        { executionId: input.executionId, settlement },
        input.expiresAt,
      );
    } finally {
      this.#liveExecutions.delete(input.executionId);
    }
  }

  async #awaitAppendWithin<T>(
    append: Promise<T>,
    deadline: number,
    description: string,
  ): Promise<T> {
    const outcome = await settleByDeadline(append, deadline, () => this.#now());
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.status === "rejected") throw outcome.error;
    throw new Error(`Timed out while attempting to ${description}`);
  }

  #appendSettlementWithin(
    input: { executionId: string; settlement: ScriptExecutionSettlementValue },
    obligationExpiresAt: number,
  ) {
    return this.#appendSettlementsWithin([{ ...input, expiresAt: obligationExpiresAt }]);
  }

  /**
   * Append a batch of settlements, each the ONE durable outcome of a script
   * execution. The at-head pass and the normal run share the settle
   * idempotency key (`script-run-settled@<executionId>`), so races collapse to
   * one settled fact at the append dedup layer. A failed append is retried by
   * the next at-head pass with the SAME settlement (`#pendingSettlements`);
   * a same-key CONFLICT means another incarnation's settlement already stands
   * — read it back and stand down instead of surfacing an error.
   */
  async #appendSettlementsWithin(
    inputs: {
      executionId: string;
      expiresAt: number;
      settlement: ScriptExecutionSettlementValue;
    }[],
  ) {
    if (!inputs.length) return Promise.resolve();
    for (const { executionId, settlement } of inputs) {
      this.#pendingSettlements.set(executionId, settlement);
    }
    const now = this.#now();
    // Normal execution reserved this interval before obligation expiry. A
    // recovery pass necessarily runs after expiry, so give each idempotent
    // retry one fresh bounded interval instead of either failing instantly or
    // blocking the processor forever. A batch uses its earliest member's
    // deadline so batching cannot extend any individual obligation.
    const appendDeadline = settlementAppendDeadline(inputs, now);
    const settlements = inputs.map((input) => this.#settlementInput(input));
    try {
      await this.#awaitAppendWithin(
        this.append(...settlements),
        appendDeadline,
        inputs.length === 1
          ? `record the settlement of script execution "${inputs[0]!.executionId}"`
          : `record ${inputs.length} script execution settlements`,
      );
    } catch (appendError) {
      let durableSettlements: ScriptExecutionSettlementValue[];
      try {
        durableSettlements = await this.#awaitAppendWithin(
          Promise.all(
            settlements.map(async (settlement, index) => {
              const event = await this.stream.getEvent({
                idempotencyKey: settlement.idempotencyKey,
              });
              const durable = settlementFromSettledEvent(event, inputs[index]!.executionId);
              if (!durable) throw appendError;
              return durable;
            }),
          ),
          settlementAppendDeadline(inputs, this.#now()),
          "verify the durable script settlement after its append failed",
        );
      } catch (verificationError) {
        if (verificationError === appendError) throw appendError;
        throw new AggregateError(
          [appendError, verificationError],
          "script settlement append failed and its durable outcome could not be verified",
        );
      }

      // A replacement incarnation may conservatively classify an execution
      // as orphaned while the old external worker is still returning. The
      // first settlement is authoritative. A failed append is a settled
      // obligation only after reading back a valid settlement for every
      // exact execution/idempotency key; the late result is then an expected,
      // explicitly observed loser rather than error telemetry.
      inputs.forEach((input, index) => {
        const durableSettlement = durableSettlements[index]!;
        console.info("[capability-host] late script settlement superseded by durable outcome", {
          attemptedFailureKind:
            input.settlement.status === "failed" ? input.settlement.failureKind : undefined,
          attemptedStatus: input.settlement.status,
          durableFailureKind:
            durableSettlement.status === "failed" ? durableSettlement.failureKind : undefined,
          durableStatus: durableSettlement.status,
          executionId: input.executionId,
        });
      });
    }
  }

  /** The one durable outcome of a script execution, as an append input. */
  #settlementInput(input: { executionId: string; settlement: ScriptExecutionSettlementValue }) {
    return scriptCompletionInput({
      executionId: input.executionId,
      idempotencyKey: this.idempotencyKey(`script-run-settled@${input.executionId}`),
      settlement: input.settlement,
    });
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The normalized scope path (error messages, __describe, the self-fallback
   * guard) — normalized once per read, from the base class's raw `path`. */
  get #scopePath(): string {
    return normalizePath(this.path);
  }
}

// -----------------------------------------------------------------------------
// Injected dependencies.
// -----------------------------------------------------------------------------

type ScriptExecutionEntrypoint = {
  run(
    code: string,
    options: {
      emittedJs?: string;
      expiresAt: number;
      preambleJs?: string;
      streamContext: Extract<StreamContext, { kind: "script-execution" }>;
    },
  ): Promise<unknown>;
};

/**
 * RUNNER-backed reads of the committed reduction. Under registry drive the
 * runner owns both cursors and the processor instance's internal checkpoint
 * never advances, so every state read this processor makes OUTSIDE a hook's
 * own args — capability resolution, the revoke guard, and the provide/revoke
 * read-your-writes barriers — must go through the runner's committed progress.
 * The hosting DO wires this to
 * `registry.reads(processor)` (lazily — `reads()` needs the registered
 * processor); test harnesses wire it to the driving StreamProcessorRunner.
 * `waitUntilEvent` takes BOTH forms as one union parameter (the registry's
 * read surface accepts it; the predicate form is in-process-only — a function
 * cannot cross the RPC facade).
 */
export type CapabilityHostProcessorReads = {
  snapshot(): Promise<{
    offset: number;
    state: ProcessorState<CapabilityHostProcessorContract>;
  }>;
  waitUntilEvent(
    input:
      | { offset: number; timeoutMs?: number; signal?: AbortSignal }
      | {
          predicate: (event: StreamEvent) => boolean;
          timeoutMs?: number;
          signal?: AbortSignal;
        },
  ): Promise<void>;
};

export type CapabilityHostProcessorDeps = {
  /** This scope's own itx — what fallback and itx-expression mounts evaluate against. */
  itx: Project;
  /** Runner-backed committed-state reads — see {@link CapabilityHostProcessorReads}. */
  reads: CapabilityHostProcessorReads;
  /**
   * Ephemeral capability-provider acquisition owned by the hosting Durable Object.
   * The processor owns only durable mount facts; production wires this to the
   * client-given hibernatable Capability Provider Pager, while pure reduction tests omit it.
   */
  invokeLiveCapability?: (
    record: Extract<CapabilityRecord, { type: "live" }>,
    path: string[],
    args: unknown[],
  ) => Promise<unknown>;
  /** Runs run-script workers in this scope. */
  scriptExecutionEntrypoint: ScriptExecutionEntrypoint;
  /** Injected clock (expiry decisions); production defaults to Date.now. */
  now?: () => number;
  /**
   * Compiles a mount's `types` string, returning problems (empty = it
   * compiles). Wired to the typechecker sidecar in production; the node
   * test harness runs without one, which skips validation.
   */
  validateCapabilityTypes?: (types: string) => Promise<string[]>;
  /**
   * Pre-execution typecheck of a requested script against this scope's
   * capability types (checkItxScriptForExecution in production; absent in
   * the node test harness, which skips the gate). Only a `problems`
   * verdict blocks the run — see ScriptExecutionCheck.
   */
  typecheckScript?: (input: {
    capabilities: CapabilityDescription[];
    code: string;
    preamble?: string;
  }) => Promise<ScriptExecutionCheck>;
  /**
   * Set-time compile of a would-be assembled preamble (checkPreamble in
   * production; absent in the node test harness, which skips the gate).
   * Returns problems attributable to the preamble's own lines.
   */
  checkPreamble?: (input: {
    capabilities: CapabilityDescription[];
    preamble: string;
  }) => Promise<string[]>;
};

// -----------------------------------------------------------------------------
// Auxiliary types and pure helpers.
// -----------------------------------------------------------------------------

/**
 * The host a capability miss falls back to, as this processor sees it after
 * evaluating the birth certificate's `fallback` expression against its own
 * itx. In practice that expression is `["capabilityHosts", ["get", "/"]]` and
 * the value is a CapabilityHostRpcTarget, but only these two read operations
 * are depended on — mounting is always local, so `provide`/`revoke` are
 * deliberately absent.
 */
type FallbackCapabilityHost = {
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown>;
  __describe(): Promise<{ capabilities: CapabilityDescription[] }>;
  /** The scope path the handle fronts, when it exposes one (the self-fallback guard reads it). */
  path?: string;
};

function isFallbackCapabilityHost(value: unknown): value is FallbackCapabilityHost {
  const host = value as Partial<FallbackCapabilityHost> | null | undefined;
  return typeof host?.invokeCapability === "function" && typeof host.__describe === "function";
}

/** ~4k tokens: how much of a mount's types `__describe` shows before
 * deferring to docs.get's budgeted reader. */
const MAX_DESCRIBED_TYPES_CHARS = 16_000;
// provide/revoke are read-your-write boundaries. A broken delivery path must
// reject the command rather than retain an RPC forever.
const INGEST_WAIT_TIMEOUT_MS = 15_000;

function truncatedTypes(types: string, mountPoint: string): string {
  if (types.length <= MAX_DESCRIBED_TYPES_CHARS) return types;
  const cut = types.slice(0, MAX_DESCRIBED_TYPES_CHARS);
  // Close a block comment the cut may have opened, so the notice stays
  // visible to a consumer rendering this as code (same rule as typeSlice).
  const openComment = cut.lastIndexOf("/*") > cut.lastIndexOf("*/");
  return (
    cut +
    (openComment ? " */" : "") +
    `\n// … truncated — read slices with itx.docs.get({ name: ${JSON.stringify(mountPoint)}, maxTokens: 4000 })`
  );
}

/** A checkPreamble problem string with its `label:line:col` position
 * stripped — the set-time gate's diff identity, so stale problems whose
 * lines merely SHIFTED when an entry above them changed length still match
 * their preexisting selves. */
function positionlessProblem(problem: string): string {
  return problem.replace(/^([a-z]+)(:\d+)+(?= —)/, "$1");
}

/** The reduce's upsert, reused by the set-time gate to preview the entry
 * table a candidate preamble-set would produce (offset unknown → 0; the gate
 * only needs order and code, and a NEW entry always sorts last either way). */
function upsertPreambleEntry(
  entries: { key: string; code: string; setAtOffset: number }[],
  input: SetPreambleInput,
): { key: string; code: string; setAtOffset: number }[] {
  const exists = entries.some((entry) => entry.key === input.key);
  return exists
    ? entries.map((entry) => (entry.key === input.key ? { ...entry, code: input.code } : entry))
    : [...entries, { key: input.key, code: input.code, setAtOffset: 0 }];
}

function resolveLongestPrefix(records: CapabilityRecord[], path: string[]) {
  let best: { record: CapabilityRecord; rest: string[] } | null = null;
  for (const record of records) {
    const matches =
      record.path.length <= path.length &&
      record.path.every((segment, index) => segment === path[index]);
    if (matches && (!best || record.path.length > best.record.path.length)) {
      best = { record, rest: path.slice(record.path.length) };
    }
  }
  return best;
}

function settlementFromSettledEvent(
  event: StreamEvent | undefined,
  executionId: string,
): ScriptExecutionSettlementValue | undefined {
  if (
    event?.type !== "events.iterate.com/capability-host/script-run-settled" ||
    event.payload?.executionId !== executionId
  ) {
    return undefined;
  }
  const parsed = ScriptExecutionSettlement.safeParse(event.payload.settlement);
  return parsed.success ? parsed.data : undefined;
}

function assertExpressionDoesNotReferenceOwnMount(
  input: Extract<ProvideCapabilityInput, { type: "itx-call" }>,
): void {
  const startsWithOwnPath = input.path.every(
    (segment, index) => input.expression[index] === segment,
  );
  if (startsWithOwnPath) {
    throw new Error(
      `itx-expression capability "${input.path.join(".")}" cannot reference its own mount path`,
    );
  }
}
