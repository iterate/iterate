// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve --json` — the machine front-end the menu-bar app drives.
//
// One newline-delimited JSON object per line on stdout; decisions read as
// NDJSON on stdin. The view is entirely stream-driven: on start it reconciles
// the backlog (requests held but not yet resolved), then one tail loop
// announces what happens next. stdin decisions append grant/reject events on
// a SEPARATE stream handle, so a click never waits behind the 60s tail.
//
// Once a grant is seen for a row (this app's or another approver's), the door's
// verdict — read via awaitSettlement, which treats `settled` as final over a
// stray reject — is the SOLE authority on the outcome; raw stream rejects for
// that row are not surfaced. So a second approver's veto can't shadow a release,
// and a grant the door ignores surfaces as `unsettled` (re-offer) instead of
// spinning to expiry.
//
// Out (stdout):
//   {"type":"status","loggedIn":true,"principal":"jane@acme.com",
//    "projectId":"prj_…","key":{"kind":"secure-enclave","keyId":"…"}|null}
//   {"type":"requested","offset":42,"method":"POST","url":"…",
//    "secretPaths":[…],"ruleKey":"…","expiresAt":"…","body":{…}|null,
//    "submitted":false}   // submitted=true ⇒ a grant already exists (awaiting the door)
//   {"type":"submitted","offset":42}   // a grant landed; the row is now awaiting the door
//   {"type":"settled","offset":42,"outcome":"released","status":200}
//   {"type":"settled","offset":42,"outcome":"rejected","reason":"expired"}
//   {"type":"unsettled","offset":42}   // grant ignored (key not enrolled?); re-offer Approve/Reject
//   {"type":"error","offset":42,"message":"…"}
//
// In (stdin):
//   {"offset":42,"decision":"granted"|"rejected"}
// ─────────────────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline";

import type { RpcStub } from "@iterate-com/capnweb";

import type { ItxAuthCredentials, Stream, StreamEvent } from "./itx-api.generated.ts";
import { loadApprovalKey } from "./approval-keys.ts";
import {
  awaitSettlement,
  connectApproval,
  EVENT,
  grant,
  reconcileBacklog,
  reject,
  safeHost,
  type RequestedPayload,
} from "./approve-core.ts";

const RESOLUTION_TYPES = [EVENT.settled, EVENT.rejected];

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

  // The held requests announced but not yet resolved — kept so a "granted"
  // decision has the payload to sign over.
  const pending = new Map<number, RequestedPayload>();
  // Offsets that reached a terminal outcome this session (released /
  // delivery-failed / rejected). A late decision on one is refused, and the
  // tail won't re-surface it.
  const resolved = new Set<number>();
  // Offsets a grant has been seen for, with a settlement watch in flight. While
  // watched, the door (via awaitSettlement) is the sole authority on the row's
  // outcome — the tail does NOT surface raw settled/rejected for it.
  const watching = new Set<number>();
  // Offsets we've appended a decision for that the tail hasn't resolved yet.
  // Guards against two rapid decision lines for one offset both passing the
  // `resolved` check before the first append is observed — which would pop Touch
  // ID twice or append an approve/reject contradiction.
  const decided = new Set<number>();

  // Watch the door's verdict for a granted request and emit the authoritative
  // outcome exactly once. awaitSettlement treats a `settled` as final over a
  // stray reject, and returns `unsettled` when the door ignored an unverifiable
  // grant — surfaced so the app can re-offer instead of spinning to expiry.
  function watchSettlement(offset: number): void {
    if (watching.has(offset) || resolved.has(offset)) return;
    watching.add(offset);
    // A dedicated handle so a settlement wait never queues behind the tail or an
    // append on their handles.
    const watchStream = project.streams.get("/") as unknown as RpcStub<Stream>;
    void (async () => {
      // A grant has been seen, so from here the door is the SOLE authority for
      // this row. A transient read failure (`error`) must NOT end the watch: that
      // would hand the row back to the live tail, which treats a raw reject as
      // terminal — a stray veto could then be reported while the door is still
      // committing a release. So on `error` we keep the watch (and the `decided`
      // claim) and re-arm; only a genuine settlement, or the door ignoring an
      // unverifiable grant (`unsettled`), ends the watch. A row nothing ever
      // settles re-arms until the request expires, when the door appends its
      // terminal event.
      while (true) {
        const settlement = await awaitSettlement(watchStream, offset);
        if (settlement.kind === "error") {
          await new Promise((resolve) => setTimeout(resolve, SETTLEMENT_RETRY_MS));
          continue;
        }
        watching.delete(offset);
        if (settlement.kind === "unsettled") {
          // The grant didn't take (unenrolled/revoked key) and the hold is still
          // open — clear the decided-claim so Approve/Reject can be used again,
          // like the terminal.
          decided.delete(offset);
          emit({ type: "unsettled", offset });
          return;
        }
        resolved.add(offset);
        pending.delete(offset);
        if (settlement.kind === "released") {
          emit({ type: "settled", offset, outcome: "released", status: settlement.status });
        } else if (settlement.kind === "delivery-failed") {
          emit({ type: "settled", offset, outcome: "delivery-failed", error: settlement.error });
        } else {
          emit({ type: "settled", offset, outcome: "rejected", reason: settlement.reason });
        }
        return;
      }
    })();
  }

  // Reconcile the backlog: replay history once, emit still-open requests (a
  // grant already on the stream shows the row submitted, not a fresh prompt),
  // and tail from the max offset so the live view starts exactly past it.
  const { open, cursor } = await reconcileBacklog(stream);
  for (const request of open) {
    pending.set(request.offset, request.payload);
    emitRequested(request.offset, request.payload, request.submitted);
    // A backlog grant is awaiting the door too — watch for its outcome.
    if (request.submitted) watchSettlement(request.offset);
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
    // The door acts on the first resolution; once a request has settled/rejected
    // (resolved) or we've already appended a decision for it (decided, awaiting
    // the door), a second decision can't take effect and must not append a
    // contradictory event or pop Touch ID again. Refuse it.
    if (resolved.has(offset) || decided.has(offset)) {
      emit({ type: "error", offset, message: "already decided" });
      return;
    }
    if (decision.decision !== "granted" && decision.decision !== "rejected") {
      emit({ type: "error", offset, message: `unknown decision "${decision.decision}"` });
      return;
    }
    if (decision.decision === "granted" && !pending.has(offset)) {
      emit({ type: "error", offset, message: "no such pending request" });
      return;
    }
    // Claim the offset BEFORE any async work so a second line queued right behind
    // this one is refused above; release it only if the append fails.
    decided.add(offset);
    try {
      if (decision.decision === "rejected") {
        await reject(appendStream, offset);
      } else {
        // Signs on the enclave path — Touch ID pops here.
        const payload = pending.get(offset)!;
        await grant({ stream: appendStream, projectId: input.projectId, key, offset, payload });
      }
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
  // by type, so requests and resolutions can never race each other.
  let tail = cursor;
  while (true) {
    let event: StreamEvent | null;
    try {
      event = await stream.waitForEvent({
        afterOffset: tail,
        eventTypes: [EVENT.requested, EVENT.granted, ...RESOLUTION_TYPES],
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
    watchSettlement: (offset: number) => void;
  },
): void {
  if (event.type === EVENT.requested) {
    const payload = event.payload as RequestedPayload;
    if (Date.parse(payload.expiresAt) <= Date.now()) return;
    state.pending.set(event.offset, payload);
    emitRequested(event.offset, payload, false);
    return;
  }
  const outcome = event.payload as {
    approvalRequestEventOffset?: number;
    status?: number;
    error?: string;
    reason?: string;
  };
  const offset = outcome.approvalRequestEventOffset;
  if (typeof offset !== "number") return;
  // A grant (this app's or another approver's) is not terminal: hand the outcome
  // to the door's verdict — a settlement watch that treats `settled` as final
  // over a stray reject. ALWAYS start the watch, even when we have no row for
  // this offset (e.g. the `requested` was dropped as client-side-expired while
  // the DO still holds it); otherwise a later stray reject could shadow a
  // release for an offset nothing is watching. Only the "submitted" UI hint is
  // gated on having a live row.
  if (event.type === EVENT.granted) {
    if (state.pending.has(offset)) emit({ type: "submitted", offset });
    state.watchSettlement(offset);
    return;
  }
  // settled / rejected. If a grant was seen, the settlement watch owns the
  // outcome — a raw reject here would be a stray veto against a winning grant,
  // and a raw settled is what the watch is already awaiting. Don't double-emit.
  if (state.watching.has(offset) || state.resolved.has(offset)) return;
  state.resolved.add(offset);
  state.pending.delete(offset);
  if (event.type === EVENT.rejected) {
    // No grant seen for this row — a rejection is authoritative (nothing to
    // release), so surface the veto.
    emit({ type: "settled", offset, outcome: "rejected", reason: outcome.reason ?? "human" });
  } else if (outcome.error !== undefined) {
    emit({ type: "settled", offset, outcome: "delivery-failed", error: outcome.error });
  } else {
    emit({ type: "settled", offset, outcome: "released", status: outcome.status ?? 0 });
  }
}

function emitRequested(offset: number, payload: RequestedPayload, submitted: boolean): void {
  emit({
    type: "requested",
    offset,
    ...payload,
    host: safeHost(payload.url),
    submitted, // a grant already exists — awaiting the door, not fresh
  });
}
