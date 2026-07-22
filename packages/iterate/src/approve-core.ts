// ─────────────────────────────────────────────────────────────────────────────
// The UI-free core of `iterate approve`, shared by both front-ends: the
// terminal (clack) one in approve.ts and the machine (NDJSON) one in
// approve-json.ts that the menu-bar app drives.
//
// Everything here is transport + policy, no rendering: connect, read the
// principal, enroll a key, append a grant/reject, and read back what the
// egress door decided. The front-ends are pure presentation over these.
// ─────────────────────────────────────────────────────────────────────────────

import type { RpcStub } from "@iterate-com/capnweb";

import {
  approvalBodySha256,
  buildApprovalMessage,
  type HumanApprovalRequestedPayload,
} from "../../../apps/os/src/domains/projects/egress-approvals.ts";
import { connectItx } from "./itx/itx-node-client.ts";
import type {
  ItxAuthCredentials,
  Project,
  Session,
  Stream,
  StreamEvent,
} from "./itx-api.generated.ts";
import { createApprovalKey, signApprovalMessage, type StoredApprovalKey } from "./approval-keys.ts";

export const EVENT = {
  requested: "events.iterate.com/project/human-approval-requested",
  granted: "events.iterate.com/project/human-approval-granted",
  rejected: "events.iterate.com/project/human-approval-rejected",
  settled: "events.iterate.com/project/human-approval-settled",
  keyAdded: "events.iterate.com/project/human-approval-key-added",
  keyRevoked: "events.iterate.com/project/human-approval-key-revoked",
} as const;

export type RequestedPayload = HumanApprovalRequestedPayload;

/** The request's host for display — falls back to the raw URL when unparseable. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Readable body text for approval front-ends, including pre-consolidation events. */
export function approvalBodyPreview(payload: RequestedPayload): string | null {
  if (payload.body !== undefined && payload.body !== null) {
    return payload.body.encoding === "base64"
      ? `[base64] ${payload.body.content}`
      : payload.body.content;
  }
  const legacyPreview = (payload as RequestedPayload & { bodyPreview?: unknown }).bodyPreview;
  return typeof legacyPreview === "string" ? legacyPreview : null;
}

/** Complete-body hash for approval front-ends, including pre-consolidation events. */
export function approvalBodyHash(payload: RequestedPayload): string | null {
  return approvalBodySha256(payload as RequestedPayload & { bodySha256?: string | null });
}

/** The canonical bytes a grant for this request signs over. */
export function messageFor(
  projectId: string,
  offset: number,
  payload: RequestedPayload,
): Uint8Array {
  return buildApprovalMessage({
    projectId,
    approvalRequestEventOffset: offset,
    requested: payload,
    decision: "granted",
  });
}

/** What the egress door did after a grant/reject — the honest outcome. */
export type Settlement =
  | { kind: "released"; status: number }
  | { kind: "delivery-failed"; error: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unsettled" } // the deadline elapsed with no outcome — safe to re-offer
  | { kind: "error"; message: string }; // a transport/protocol failure — NOT re-offerable

/** Connect a session, read who we are, and hand back the project's root stream. */
export async function connectApproval(input: {
  auth: ItxAuthCredentials;
  baseUrl: string;
  projectId: string;
  headers?: Record<string, string>;
}): Promise<{
  session: RpcStub<Session>;
  project: RpcStub<Project>;
  stream: RpcStub<Stream>;
  /** The logged-in identity ("admin" for an admin-secret session), or null. */
  principal: string | null;
}> {
  const session = connectItx({
    auth: input.auth,
    baseUrl: input.baseUrl,
    headers: input.headers,
  }) as RpcStub<Session>;
  let principal: string | null = null;
  try {
    principal = (await session.__describe()).principal ?? null;
  } catch {
    // Identity is a nicety; a describe failure must not stop approvals.
  }
  const project = session.projects.get(input.projectId) as unknown as RpcStub<Project>;
  const stream = project.streams.get("/") as RpcStub<Stream>;
  return { session, project, stream, principal };
}

/**
 * Enroll this machine's key: mint (Secure Enclave when able) if absent, then
 * append `human-approval-key-added` — idempotent, since the reducer ignores a
 * known keyId. From here grants from this machine must be signed.
 */
export async function enrollKey(input: {
  existing: StoredApprovalKey | null;
  projectId: string;
  softwareKey?: boolean;
  stream: RpcStub<Stream>;
  log?: (message: string) => void;
}): Promise<StoredApprovalKey> {
  const key =
    input.existing ??
    (await createApprovalKey({
      projectId: input.projectId,
      label: `${process.env.USER ?? "user"}@${process.platform}`,
      software: input.softwareKey,
      log: input.log,
    }));
  await input.stream.append({
    type: EVENT.keyAdded,
    payload: { keyId: key.keyId, publicKey: key.publicKey, label: key.label },
  });
  return key;
}

/**
 * Grant one held request. Signs with the enrolled key (Touch ID on the
 * enclave path) unless a signature was already produced elsewhere (the
 * terminal `--native` dialog signs as it approves). A keyless project takes a
 * plain grant.
 */
export async function grant(input: {
  stream: RpcStub<Stream>;
  projectId: string;
  key: StoredApprovalKey | null;
  offset: number;
  payload: RequestedPayload;
  signature?: string;
}): Promise<void> {
  let signed = input.signature;
  if (signed === undefined && input.key !== null) {
    signed = await signApprovalMessage(
      input.key,
      messageFor(input.projectId, input.offset, input.payload),
    );
  }
  await input.stream.append({
    type: EVENT.granted,
    payload: {
      approvalRequestEventOffset: input.offset,
      ...(input.key === null ? {} : { keyId: input.key.keyId, signature: signed }),
    },
  });
}

/** Reject one held request — deny is the fail-safe direction, never signed. */
export async function reject(stream: RpcStub<Stream>, offset: number): Promise<void> {
  await stream.append({
    type: EVENT.rejected,
    payload: { approvalRequestEventOffset: offset, reason: "human" },
  });
}

/**
 * Page the project stream once and return every approval request still open,
 * oldest first, plus the highest offset seen so a live tail resumes exactly past
 * it (no gap, no replay). Each is flagged `submitted` when a grant is winning but
 * the door hasn't settled it — a front-end then shows it awaiting the door rather
 * than offering a second, racing decision.
 *
 * The door acts on the FIRST resolution and appends `settled` only when it
 * releases, so this mirrors that authority: a request is terminal when a
 * `settled` exists, or when the first grant/reject (by offset order) was a
 * reject. A stray reject that lands AFTER a winning grant does NOT close the
 * hold — the release can still succeed, so it stays open (submitted) and the
 * reconnecting approver keeps watching for its settlement.
 *
 * Both front-ends reconcile through this one function so terminal and machine
 * views can't derive "still open" differently.
 */
export async function reconcileBacklog(stream: RpcStub<Stream>): Promise<{
  open: Array<{ offset: number; payload: RequestedPayload; submitted: boolean }>;
  cursor: number;
}> {
  const requests = new Map<number, RequestedPayload>();
  const settled = new Set<number>(); // door released/failed — always terminal
  const firstResolution = new Map<number, "granted" | "rejected">(); // door honors the first
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [EVENT.requested, EVENT.granted, EVENT.settled, EVENT.rejected],
    });
    if (page.length === 0) break;
    for (const event of page) {
      cursor = event.offset;
      if (event.type === EVENT.requested) {
        requests.set(event.offset, event.payload as RequestedPayload);
        continue;
      }
      const ref = (event.payload as { approvalRequestEventOffset?: number })
        .approvalRequestEventOffset;
      if (typeof ref !== "number") continue;
      if (event.type === EVENT.settled) settled.add(ref);
      // Pages arrive ascending, so the first grant/reject we see IS the first by
      // offset — the one the door acted on.
      else if (!firstResolution.has(ref)) {
        firstResolution.set(ref, event.type === EVENT.granted ? "granted" : "rejected");
      }
    }
  }
  const now = Date.now();
  // Map iteration is insertion order — paged ascending — so this is oldest first.
  const open = [...requests]
    .filter(
      ([offset, payload]) =>
        !settled.has(offset) &&
        firstResolution.get(offset) !== "rejected" &&
        Date.parse(payload.expiresAt) > now,
    )
    .map(([offset, payload]) => ({
      offset,
      payload,
      submitted: firstResolution.get(offset) === "granted",
    }));
  return { open, cursor };
}

/** A `settled` event's outcome — released with the upstream status, or a delivery failure. */
function settledOutcome(
  event: StreamEvent,
): Extract<Settlement, { kind: "released" | "delivery-failed" }> {
  const outcome = event.payload as { status?: number; error?: string };
  return outcome.error !== undefined
    ? { kind: "delivery-failed", error: outcome.error }
    : { kind: "released", status: outcome.status ?? 0 };
}

/**
 * How long to wait for the door to settle a grant. The door appends `settled`
 * only AFTER the approved upstream `fetch` finishes, so the window must outlast
 * a slow-but-succeeding egress — a shorter wait would misreport a valid grant
 * as `unsettled` (or, after a stray reject, a false rejection). Chunked into
 * bounded one-shot waits so no single RPC spans it.
 */
const SETTLEMENT_WINDOW_MS = 120_000;
const SETTLEMENT_CHUNK_MS = 25_000;

/**
 * Read back what the egress door did with a request: released (with the
 * upstream status), delivery-failed, rejected, or — if nothing lands in the
 * window — unsettled (an unverifiable signature is ignored server-side, so
 * the hold waits for a good grant or expiry).
 *
 * `settled` is authoritative. The door acts on the FIRST resolution and appends
 * `settled` ONLY after it releases egress, so a `settled` for this offset always
 * means a grant won — even if a second approver raced in a `rejected`. On seeing
 * a rejection we therefore re-scan for a settled before trusting the veto;
 * released beats a stray reject every time.
 */
export async function awaitSettlement(
  stream: RpcStub<Stream>,
  offset: number,
  windowMs = SETTLEMENT_WINDOW_MS,
): Promise<Settlement> {
  const forThisRequest = (candidate: StreamEvent) =>
    (candidate.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
    offset;

  // Wait for the first matching event before `deadline`, re-arming a one-shot
  // waitForEvent on chunk timeouts (and transient stream restarts). Returns null
  // once the deadline passes.
  const waitUntil = async (
    eventTypes: readonly string[],
    deadline: number,
  ): Promise<StreamEvent | null> => {
    while (Date.now() < deadline) {
      try {
        return await stream.waitForEvent({
          afterOffset: offset,
          eventTypes: [...eventTypes],
          predicate: forThisRequest,
          timeoutMs: Math.min(deadline - Date.now(), SETTLEMENT_CHUNK_MS),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Timed out waiting for stream event")
        ) {
          continue;
        }
        throw error;
      }
    }
    return null;
  };

  try {
    const event = await waitUntil([EVENT.settled, EVENT.rejected], Date.now() + windowMs);
    if (event === null) return { kind: "unsettled" };
    if (event.type === EVENT.settled) return settledOutcome(event);

    // A rejection is authoritative only if no grant won. The door acts on the
    // FIRST resolution and appends `settled` only after the winning grant's
    // upstream fetch finishes — up to a full egress window after it acted — so a
    // reject that arrives late in the first window can still be shadowed by a
    // slow `settled`. Re-scan with a FRESH window (not the leftover budget):
    // sharing one deadline could leave a late reject no time to find the settled,
    // reporting a stray veto as terminal while egress is actually releasing. The
    // extra wait only ever runs after an observed reject, and exits the instant a
    // `settled` lands.
    const settled = await waitUntil([EVENT.settled], Date.now() + windowMs);
    return settled === null
      ? { kind: "rejected", reason: (event.payload as { reason?: string }).reason ?? "human" }
      : settledOutcome(settled);
  } catch (error) {
    // A transport/protocol failure — NOT the deadline. Reporting this as
    // `unsettled` would re-enable the action and risk a contradictory decision
    // against a request the door may already be settling; surface it as an error.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
