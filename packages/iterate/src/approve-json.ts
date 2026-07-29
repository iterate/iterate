// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve --json` — the machine front-end the menu-bar app drives.
//
// One newline-delimited JSON object per line on stdout; decisions read as
// NDJSON on stdin. The view is entirely stream-driven: on start it reconciles
// the backlog (batches held but not yet resolved), then one tail loop
// announces what happens next. stdin decisions append decided events on a
// SEPARATE stream handle, so a click never waits behind the 60s tail.
//
// The unit is the BATCH (a lone request is a batch of one): each `requested`
// row is one batch, keyed by its event offset, and one stdin decision
// approves or rejects ALL of it. The door honors the FIRST decided event, so
// once one is seen the settlement watch — which waits for every approved
// index's settle — is the sole authority on the row's outcome; a decision
// the door ignores surfaces as `unsettled` (re-offer) instead of spinning to
// expiry.
//
// Out (stdout):
//   {"type":"status","loggedIn":true,"principal":"jane@acme.com",
//    "projectId":"prj_…","key":{"kind":"secure-enclave","keyId":"…"}|null}
//   {"type":"requested","offset":42,"summary":"POST api.stripe.com",
//    "count":1,"requests":[{"method":"POST","url":"…","secretPaths":[…],
//    "body":{…}|null}],"secretPaths":[…],"ruleKey":"…","expiresAt":"…",
//    "submitted":false}   // submitted=true ⇒ a decision already exists (awaiting the door)
//   {"type":"submitted","offset":42}   // a decision landed; the row is now awaiting the door
//   {"type":"settled","offset":42,"outcome":"released","statuses":[200,200]}
//   {"type":"settled","offset":42,"outcome":"delivery-failed","errors":["boom"]}
//   {"type":"settled","offset":42,"outcome":"rejected","reason":"expiry"}
//   {"type":"unsettled","offset":42}   // decision ignored (key not enrolled?); re-offer Approve/Reject
//   {"type":"error","offset":42,"message":"…"}
//
// In (stdin):
//   {"offset":42,"decision":"approve"|"reject"}
// ─────────────────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline";

import type { RpcStub } from "@iterate-com/capnweb";

import type { ItxAuthCredentials, Stream, StreamEvent } from "./itx-api.generated.ts";
import { loadApprovalKey } from "./approval-keys.ts";
import {
  awaitSettlement,
  connectApproval,
  decide,
  EVENT,
  reconcileBacklog,
  summarizeRequests,
  type RequestedPayload,
  type Verdict,
} from "./approve-core.ts";

/** Back-off before re-arming a settlement watch after a transient read error. */
const SETTLEMENT_RETRY_MS = 2_000;

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Emitted (and the process exits) when there is no usable session yet. */
export function emitNeedsLogin(): void {
  emit({ type: "status", loggedIn: false });
}

export async function runApprovalJson(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
}): Promise<void> {
  const { project, stream, principal } = await connectApproval(input);
  // Appends ride a second handle so a decision never queues behind the tail's
  // in-flight 60s waitForEvent on the first.
  const appendStream = project.streams.get("/") as unknown as RpcStub<Stream>;
  const key = await loadApprovalKey(input.projectId);

  emit({
    type: "status",
    loggedIn: true,
    principal,
    projectId: input.projectId,
    key: key === null ? null : { kind: key.kind, keyId: key.keyId, label: key.label },
  });

  // The held batches announced but not yet resolved — kept so a decision has
  // the payload to sign over.
  const pending = new Map<number, RequestedPayload>();
  // Offsets that reached a terminal outcome this session (released /
  // delivery-failed / rejected). A late decision on one is refused, and the
  // tail won't re-surface it.
  const resolved = new Set<number>();
  // Offsets a decision has been seen for, with a settlement watch in flight.
  // While watched, the door (via awaitSettlement) is the sole authority on
  // the row's outcome — the tail does NOT surface raw settles for it.
  const watching = new Set<number>();
  // Offsets we've appended a decision for that the tail hasn't resolved yet.
  // Guards against two rapid decision lines for one offset both passing the
  // `resolved` check before the first append is observed — which would pop
  // Touch ID twice or append a dead-weight contradiction.
  const decided = new Set<number>();

  // Watch the door's outcome for a decided batch and emit it exactly once.
  // awaitSettlement waits for every approved index's settle, reports the
  // door's own expiry decision as rejected, and returns `unsettled` when the
  // door ignored an unverifiable decision — surfaced so the app can re-offer
  // instead of spinning to expiry.
  function watchSettlement(offset: number, verdicts: Verdict[]): void {
    if (watching.has(offset) || resolved.has(offset)) return;
    watching.add(offset);
    // A dedicated handle so a settlement wait never queues behind the tail or an
    // append on their handles.
    const watchStream = project.streams.get("/") as unknown as RpcStub<Stream>;
    void (async () => {
      // A decision has been seen, so from here the door is the SOLE authority
      // for this row. A transient read failure (`error`) must NOT end the
      // watch — that would hand the row back to the live tail mid-outcome. So
      // on `error` we keep the watch (and the `decided` claim) and re-arm;
      // only a genuine outcome, or the door ignoring an unverifiable decision
      // (`unsettled`), ends the watch. A row nothing ever settles re-arms
      // until the batch expires, when the door appends its expiry decision.
      while (true) {
        const settlement = await awaitSettlement(watchStream, offset, verdicts);
        if (settlement.kind === "error") {
          await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_RETRY_MS));
          continue;
        }
        watching.delete(offset);
        if (settlement.kind === "unsettled") {
          // The decision didn't take (unenrolled/revoked key) and the hold is
          // still open — clear the decided-claim so Approve/Reject can be used
          // again, like the terminal.
          decided.delete(offset);
          emit({ type: "unsettled", offset });
          return;
        }
        resolved.add(offset);
        pending.delete(offset);
        if (settlement.kind === "released") {
          const errors = settlement.outcomes.flatMap((outcome) =>
            outcome.error === null ? [] : [outcome.error],
          );
          if (errors.length === 0) {
            emit({
              type: "settled",
              offset,
              outcome: "released",
              statuses: settlement.outcomes.map((outcome) => outcome.status),
            });
          } else {
            emit({ type: "settled", offset, outcome: "delivery-failed", errors });
          }
        } else {
          emit({ type: "settled", offset, outcome: "rejected", reason: settlement.decidedBy });
        }
        return;
      }
    })();
  }

  // Reconcile the backlog: replay history once, emit still-open batches (a
  // decision already on the stream shows the row submitted, not a fresh
  // prompt), and tail from the max offset so the live view starts exactly
  // past it.
  const { open, cursor } = await reconcileBacklog(stream);
  for (const batch of open) {
    pending.set(batch.offset, batch.payload);
    emitRequested(batch.offset, batch.payload, batch.submitted);
    // A backlog decision is awaiting the door too — watch for its outcome.
    if (batch.submitted) watchSettlement(batch.offset, batch.verdicts!);
  }

  // Decisions run one at a time: signing pops Touch ID, and two enclave
  // signatures must not race. Each line chains after the last; handleDecision
  // never throws, so the chain never breaks.
  let decisions: Promise<void> = Promise.resolve();
  const stdin = createInterface({ input: process.stdin });
  stdin.on("line", (raw) => {
    decisions = decisions.then(() => handleDecision(raw));
  });
  // The menu bar is our parent; if it dies, stdin closes. Stop rather than
  // linger with a live WebSocket and approval authority nobody is watching.
  stdin.on("close", () => process.exit(0));

  async function handleDecision(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    let decision: { offset?: number; decision?: string };
    try {
      decision = JSON.parse(trimmed) as { offset?: number; decision?: string };
    } catch {
      emit({ type: "error", message: "malformed decision line" });
      return;
    }
    const offset = decision.offset;
    if (typeof offset !== "number") return;
    // The door acts on the first decision; once a batch has resolved, or
    // we've already appended a decision for it (decided, awaiting the door),
    // a second decision can't take effect and must not append a dead-weight
    // event or pop Touch ID again. Refuse it.
    if (resolved.has(offset) || decided.has(offset)) {
      emit({ type: "error", offset, message: "already decided" });
      return;
    }
    if (decision.decision !== "approve" && decision.decision !== "reject") {
      emit({ type: "error", offset, message: `unknown decision "${decision.decision}"` });
      return;
    }
    const payload = pending.get(offset);
    if (payload === undefined) {
      emit({ type: "error", offset, message: "no such pending batch" });
      return;
    }
    // Claim the offset BEFORE any async work so a second line queued right behind
    // this one is refused above; release it only if the append fails.
    decided.add(offset);
    const verdicts = payload.requests.map(
      (): Verdict => (decision.decision === "approve" ? "approve" : "reject"),
    );
    try {
      // Signs on the enclave path — Touch ID pops here (approve only;
      // all-reject decisions are never signed).
      await decide({
        stream: appendStream,
        projectId: input.projectId,
        key,
        offset,
        payload,
        verdicts,
      });
    } catch (error) {
      decided.delete(offset); // the append failed — allow another attempt
      emit({
        type: "error",
        offset,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Single live tail from the reconciled cursor: one subscription, dispatched
  // by type, so requests and decisions can never race each other.
  let tail = cursor;
  while (true) {
    let event: StreamEvent | null;
    try {
      event = await stream.waitForEvent({
        afterOffset: tail,
        eventTypes: [EVENT.requested, EVENT.decided, EVENT.settled],
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Timed out waiting for stream event")) {
        continue;
      }
      throw error;
    }
    tail = event.offset;
    dispatch(event, { pending, resolved, watching, watchSettlement });
  }
}

function dispatch(
  event: StreamEvent,
  state: {
    pending: Map<number, RequestedPayload>;
    resolved: Set<number>;
    watching: Set<number>;
    watchSettlement: (offset: number, verdicts: Verdict[]) => void;
  },
): void {
  if (event.type === EVENT.requested) {
    const payload = event.payload as RequestedPayload;
    if (Date.parse(payload.expiresAt) <= Date.now()) return;
    state.pending.set(event.offset, payload);
    emitRequested(event.offset, payload, false);
    return;
  }
  const payload = event.payload as {
    approvalRequestEventOffset?: number;
    verdicts?: Verdict[];
    decidedBy?: string;
  };
  const offset = payload.approvalRequestEventOffset;
  if (typeof offset !== "number") return;
  if (event.type === EVENT.decided) {
    if (state.watching.has(offset) || state.resolved.has(offset)) return;
    const verdicts = Array.isArray(payload.verdicts) ? payload.verdicts : [];
    const anyApproved = verdicts.includes("approve");
    if (!anyApproved) {
      // All-reject (a human's veto, or the door's expiry) is terminal on the
      // spot — nothing will settle.
      state.resolved.add(offset);
      state.pending.delete(offset);
      emit({
        type: "settled",
        offset,
        outcome: "rejected",
        reason: payload.decidedBy === "expiry" ? "expiry" : "human",
      });
      return;
    }
    // A decision with approvals (this app's or another approver's) hands the
    // outcome to the settlement watch. ALWAYS start it, even when we have no
    // row for this offset (e.g. the `requested` was dropped as
    // client-side-expired while the DO still holds it). Only the "submitted"
    // UI hint is gated on having a live row.
    if (state.pending.has(offset)) emit({ type: "submitted", offset });
    state.watchSettlement(offset, verdicts);
    return;
  }
  // Raw settles: the watch started by the batch's decided event owns them —
  // settles can only ever land after a decision, so there is nothing to do
  // here beyond ignoring redundant deliveries.
}

function emitRequested(offset: number, payload: RequestedPayload, submitted: boolean): void {
  emit({
    type: "requested",
    offset,
    summary: summarizeRequests(payload.requests),
    count: payload.requests.length,
    requests: payload.requests,
    secretPaths: [...new Set(payload.requests.flatMap((request) => request.secretPaths))],
    ruleKey: payload.ruleKey,
    ruleDescription: payload.ruleDescription,
    expiresAt: payload.expiresAt,
    submitted, // a decision already exists — awaiting the door, not fresh
  });
}
