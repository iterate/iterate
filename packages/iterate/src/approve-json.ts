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
//    "secretPaths":[…],"ruleKey":"…","expiresAt":"…","bodyPreview":"…"|null}
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
import { loadApprovalKey, type StoredApprovalKey } from "./approval-keys.ts";
import { connectApproval, EVENT, grant, reject, type RequestedPayload } from "./approve-core.ts";

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

  // Reconcile the backlog: replay history once, emit still-pending requests,
  // and return the max offset so the live tail starts exactly past it (no
  // live-only race, no gap).
  const cursor = await reconcileBacklog(stream, key, pending);

  createInterface({ input: process.stdin }).on("line", (raw) => {
    void handleDecision(raw).catch((error: unknown) => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handleDecision(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === "") return;
    const decision = JSON.parse(trimmed) as { offset?: number; decision?: string };
    if (typeof decision.offset !== "number") return;
    if (decision.decision === "rejected") {
      await reject(appendStream, decision.offset);
      return;
    }
    if (decision.decision !== "granted") return;
    const payload = pending.get(decision.offset);
    if (payload === undefined) {
      emit({ type: "error", offset: decision.offset, message: "no such pending request" });
      return;
    }
    try {
      // Signs on the enclave path — Touch ID pops here.
      await grant({
        stream: appendStream,
        projectId: input.projectId,
        key,
        offset: decision.offset,
        payload,
      });
    } catch (error) {
      emit({
        type: "error",
        offset: decision.offset,
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
        eventTypes: [EVENT.requested, ...RESOLUTION_TYPES],
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Timed out waiting for stream event")) {
        continue;
      }
      throw error;
    }
    tail = event.offset;
    dispatch(event, key, pending);
  }
}

/**
 * Read the whole stream once (paged), tracking which held requests are still
 * unresolved and unexpired, emit those, and return the highest offset seen so
 * the caller tails from exactly past it.
 */
async function reconcileBacklog(
  stream: RpcStub<Stream>,
  key: StoredApprovalKey | null,
  pending: Map<number, RequestedPayload>,
): Promise<number> {
  const requests = new Map<number, RequestedPayload>();
  const resolved = new Set<number>();
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [EVENT.requested, ...RESOLUTION_TYPES],
    });
    if (page.length === 0) break;
    for (const event of page) {
      cursor = event.offset;
      if (event.type === EVENT.requested) {
        requests.set(event.offset, event.payload as RequestedPayload);
      } else {
        const ref = (event.payload as { approvalRequestEventOffset?: number })
          .approvalRequestEventOffset;
        if (typeof ref === "number") resolved.add(ref);
      }
    }
  }
  for (const [offset, payload] of requests) {
    if (resolved.has(offset)) continue;
    if (Date.parse(payload.expiresAt) <= Date.now()) continue;
    pending.set(offset, payload);
    emitRequested(offset, payload, key);
  }
  return cursor;
}

function dispatch(
  event: StreamEvent,
  key: StoredApprovalKey | null,
  pending: Map<number, RequestedPayload>,
): void {
  if (event.type === EVENT.requested) {
    const payload = event.payload as RequestedPayload;
    if (Date.parse(payload.expiresAt) <= Date.now()) return;
    pending.set(event.offset, payload);
    emitRequested(event.offset, payload, key);
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
  pending.delete(offset);
  if (event.type === EVENT.rejected) {
    emit({ type: "settled", offset, outcome: "rejected", reason: outcome.reason ?? "human" });
  } else if (outcome.error !== undefined) {
    emit({ type: "settled", offset, outcome: "delivery-failed", error: outcome.error });
  } else {
    emit({ type: "settled", offset, outcome: "released", status: outcome.status ?? 0 });
  }
}

function emitRequested(
  offset: number,
  payload: RequestedPayload,
  key: StoredApprovalKey | null,
): void {
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
    signed: key !== null,
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
