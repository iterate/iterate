// ─────────────────────────────────────────────────────────────────────────────
// The UI-free core of `iterate approve`, shared by both front-ends: the
// terminal (clack) one in approve.ts and the machine (NDJSON) one in
// approve-json.ts that the menu-bar app drives.
//
// Everything here is transport + policy, no rendering: connect, read the
// principal, enroll a key, append a grant/reject, and read back what the
// egress door decided. The front-ends are pure presentation over these.
// ─────────────────────────────────────────────────────────────────────────────

import type { RpcStub } from "capnweb";

import { connectItx } from "../../../apps/os/src/itx-client.ts";
import {
  buildApprovalMessage,
  type HumanApprovalRequestedPayload,
} from "../../../apps/os/src/domains/projects/egress-approvals.ts";
import type { ItxAuthCredentials, Project, Session, Stream } from "./itx-api.generated.ts";
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
  | { kind: "unsettled" };

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
 * Page the project stream once and return every approval request still open —
 * a `requested` with no matching `settled`/`rejected` that hasn't expired —
 * oldest first, plus the highest offset seen so a live tail resumes exactly
 * past it (no gap, no replay). Each is flagged `submitted` when a grant already
 * exists but the door hasn't settled it: a bare grant is NOT terminal (the door
 * may ignore an unverifiable one), so such a hold stays open, but a front-end
 * shows it awaiting the door rather than offering a second, racing decision.
 *
 * Both front-ends reconcile through this one function so terminal and machine
 * views can't derive "still open" differently.
 */
export async function reconcileBacklog(stream: RpcStub<Stream>): Promise<{
  open: Array<{ offset: number; payload: RequestedPayload; submitted: boolean }>;
  cursor: number;
}> {
  const requests = new Map<number, RequestedPayload>();
  const resolved = new Set<number>(); // settled or rejected — terminal
  const submitted = new Set<number>(); // a grant exists, door hasn't settled it
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
      if (event.type === EVENT.granted) submitted.add(ref);
      else resolved.add(ref);
    }
  }
  const now = Date.now();
  // Map iteration is insertion order — paged ascending — so this is oldest first.
  const open = [...requests]
    .filter(([offset, payload]) => !resolved.has(offset) && Date.parse(payload.expiresAt) > now)
    .map(([offset, payload]) => ({ offset, payload, submitted: submitted.has(offset) }));
  return { open, cursor };
}

/**
 * Read back what the egress door did with a request: released (with the
 * upstream status), delivery-failed, rejected, or — if nothing lands in the
 * window — unsettled (an unverifiable signature is ignored server-side, so
 * the hold waits for a good grant or expiry).
 */
export async function awaitSettlement(
  stream: RpcStub<Stream>,
  offset: number,
  timeoutMs = 30_000,
): Promise<Settlement> {
  try {
    const event = await stream.waitForEvent({
      afterOffset: offset,
      eventTypes: [EVENT.settled, EVENT.rejected],
      predicate: (candidate) =>
        (candidate.payload as { approvalRequestEventOffset?: number })
          .approvalRequestEventOffset === offset,
      timeoutMs,
    });
    const outcome = event.payload as { status?: number; error?: string; reason?: string };
    if (event.type === EVENT.rejected)
      return { kind: "rejected", reason: outcome.reason ?? "human" };
    if (outcome.error !== undefined) return { kind: "delivery-failed", error: outcome.error };
    return { kind: "released", status: outcome.status ?? 0 };
  } catch {
    return { kind: "unsettled" };
  }
}
