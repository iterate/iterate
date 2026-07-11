// ─────────────────────────────────────────────────────────────────────────────
// `iterate approve --json` — the machine front-end the menu-bar app drives.
//
// One newline-delimited JSON object per line on stdout; decisions read as
// NDJSON on stdin. The view is entirely stream-driven: on start it reconciles
// the backlog (requests held but not yet resolved), then one tail loop
// announces what happens next. stdin decisions append grant/reject events on
// a SEPARATE stream handle, so a click never waits behind the 60s tail.
//
// Out (stdout):
//   {"type":"status","loggedIn":true,"principal":"jane@acme.com",
//    "projectId":"prj_…","key":{"kind":"secure-enclave","keyId":"…"}|null}
//   {"type":"requested","offset":42,"method":"POST","url":"…","host":"…",
//    "secretPaths":[…],"ruleKey":"…","expiresAt":"…","bodyPreview":"…"|null,
//    "submitted":false}   // submitted=true ⇒ a grant already exists (awaiting the door)
//   {"type":"submitted","offset":42}   // a grant landed; the row is now awaiting the door
//   {"type":"settled","offset":42,"outcome":"released","status":200}
//   {"type":"settled","offset":42,"outcome":"rejected","reason":"expired"}
//   {"type":"error","offset":42,"message":"…"}
//
// In (stdin):
//   {"offset":42,"decision":"granted"|"rejected"}
// ─────────────────────────────────────────────────────────────────────────────

import { createInterface } from "node:readline";

import type { RpcStub } from "capnweb";

import type { ItxAuthCredentials, Stream, StreamEvent } from "./itx-api.generated.ts";
import { loadApprovalKey } from "./approval-keys.ts";
import {
  connectApproval,
  EVENT,
  grant,
  reconcileBacklog,
  reject,
  safeHost,
  type RequestedPayload,
} from "./approve-core.ts";

const RESOLUTION_TYPES = [EVENT.settled, EVENT.rejected];

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
  // Offsets the door RELEASED (a `settled` landed). `settled` is authoritative:
  // the door acts on the first resolution and settles only on release, so a
  // released offset can no longer be vetoed — a later `rejected` is a stray.
  const released = new Set<number>();
  // Offsets that reached any terminal outcome this session (released or an
  // authoritative rejection). A decision on one of these is refused.
  const resolved = new Set<number>();

  // Reconcile the backlog: replay history once, emit still-open requests (a
  // grant already on the stream shows the row submitted, not a fresh prompt),
  // and tail from the max offset so the live view starts exactly past it.
  const { open, cursor } = await reconcileBacklog(stream);
  for (const request of open) {
    pending.set(request.offset, request.payload);
    emitRequested(request.offset, request.payload, request.submitted);
  }

  // Decisions run one at a time: signing pops Touch ID, and two enclave
  // signatures must not race. Each line chains after the last; handleDecision
  // never throws, so the chain never breaks.
  let decisions: Promise<void> = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (raw) => {
    decisions = decisions.then(() => handleDecision(raw));
  });

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
    // The door acts on the first resolution; once a request has settled or been
    // rejected, a late decision (e.g. Reject on a stale notification banner after
    // a grant already released) can't take effect and must not append a
    // contradictory event. Refuse it — the row is already gone from the view.
    if (resolved.has(offset)) {
      emit({ type: "error", offset, message: "already resolved" });
      return;
    }
    try {
      if (decision.decision === "rejected") {
        await reject(appendStream, offset);
      } else if (decision.decision === "granted") {
        const payload = pending.get(offset);
        if (payload === undefined) {
          emit({ type: "error", offset, message: "no such pending request" });
          return;
        }
        // Signs on the enclave path — Touch ID pops here.
        await grant({ stream: appendStream, projectId: input.projectId, key, offset, payload });
      } else {
        // Any decision we can't act on still gets an offset-bearing error so
        // the app clears that row's spinner instead of spinning forever.
        emit({ type: "error", offset, message: `unknown decision "${decision.decision}"` });
      }
    } catch (error) {
      // Every failure carries the offset so the app can clear that row.
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
    dispatch(event, { pending, released, resolved });
  }
}

function dispatch(
  event: StreamEvent,
  state: { pending: Map<number, RequestedPayload>; released: Set<number>; resolved: Set<number> },
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
  // A grant is not terminal: mark the row submitted (awaiting the door), keep
  // it pending. Only settled/rejected remove it.
  if (event.type === EVENT.granted) {
    if (state.pending.has(offset)) emit({ type: "submitted", offset });
    return;
  }
  if (event.type === EVENT.rejected) {
    // The door acts on the first resolution and settles only on release, so a
    // released offset can't be vetoed — a `rejected` that arrives after (a
    // second approver racing a grant that already won) is a stray. Ignore it.
    if (state.released.has(offset)) return;
    state.resolved.add(offset);
    state.pending.delete(offset);
    emit({ type: "settled", offset, outcome: "rejected", reason: outcome.reason ?? "human" });
    return;
  }
  // settled — authoritative: released or a delivery failure. This also corrects
  // a row a stray reject removed just before, if the two raced.
  state.released.add(offset);
  state.resolved.add(offset);
  state.pending.delete(offset);
  if (outcome.error !== undefined) {
    emit({ type: "settled", offset, outcome: "delivery-failed", error: outcome.error });
  } else {
    emit({ type: "settled", offset, outcome: "released", status: outcome.status ?? 0 });
  }
}

function emitRequested(offset: number, payload: RequestedPayload, submitted: boolean): void {
  emit({
    type: "requested",
    offset,
    method: payload.method,
    url: payload.url,
    host: safeHost(payload.url),
    secretPaths: payload.secretPaths,
    ruleKey: payload.ruleKey,
    expiresAt: payload.expiresAt,
    bodyPreview: payload.bodyPreview,
    submitted, // a grant already exists — awaiting the door, not fresh
  });
}
