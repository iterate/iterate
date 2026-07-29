// ─────────────────────────────────────────────────────────────────────────────
// The UI-free core of `iterate approve`, shared by both front-ends: the
// terminal (clack) one in approve.ts and the machine (NDJSON) one in
// approve-json.ts that the menu-bar app drives.
//
// Everything here is transport + policy, no rendering: connect, read the
// principal, enroll a key, append a decision, and read back what the egress
// door did. The front-ends are pure presentation over these.
//
// The unit of approval is the BATCH: one `human-approval-requested` event
// carries 1..n held requests (a script run's concurrent burst coalesces at
// the egress door; a lone request is a batch of one), and ONE
// `human-approval-decided` event answers it with a verdict per index. The
// door honors the FIRST decided event referencing a batch — there is no
// grant-vs-stray-reject race to reason about.
// ─────────────────────────────────────────────────────────────────────────────

import type { RpcStub } from "@iterate-com/capnweb";

import {
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
  decided: "events.iterate.com/project/human-approval-decided",
  settled: "events.iterate.com/project/human-approval-settled",
  keyAdded: "events.iterate.com/project/human-approval-key-added",
  keyRevoked: "events.iterate.com/project/human-approval-key-revoked",
} as const;

export type RequestedPayload = HumanApprovalRequestedPayload;
export type Verdict = "approve" | "reject";

/** The request's host for display — falls back to the raw URL when unparseable. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One display line naming a batch: "POST api.stripe.com" for a batch of one,
 * "12 requests (10x gmail.googleapis.com, 2x api.stripe.com)" otherwise —
 * busiest host first. */
export function summarizeRequests(requests: RequestedPayload["requests"]): string {
  if (requests.length === 1) {
    const only = requests[0]!;
    return `${only.method} ${safeHost(only.url)}`;
  }
  const counts = new Map<string, number>();
  for (const request of requests) {
    const host = safeHost(request.url);
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  const breakdown = [...counts.entries()]
    .sort(([hostA, countA], [hostB, countB]) => countB - countA || hostA.localeCompare(hostB))
    .map(([host, count]) => `${count}x ${host}`)
    .join(", ");
  return `${requests.length} requests (${breakdown})`;
}

/** The canonical bytes a decision for this batch signs over (approval.v2 —
 * covers every request subject plus the verdict per index). */
export function messageFor(
  projectId: string,
  offset: number,
  payload: RequestedPayload,
  verdicts: readonly Verdict[],
): Uint8Array {
  return buildApprovalMessage({
    projectId,
    approvalRequestEventOffset: offset,
    requests: payload.requests,
    verdicts,
  });
}

/** What the egress door did after a decision — the honest outcome. */
export type Settlement =
  | {
      kind: "released";
      /** One entry per approved index, in index order. */
      outcomes: Array<{ index: number; status: number | null; error: string | null }>;
    }
  | { kind: "rejected"; decidedBy: "human" | "expiry"; reason?: string }
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
 * known keyId. From here approvals from this machine must be signed.
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
 * Decide one held batch: ONE event, ONE signature, a verdict per index.
 * Signs with the enrolled key (Touch ID on the enclave path) whenever any
 * verdict approves, unless a signature was already produced elsewhere (the
 * terminal `--native` dialog signs as it approves). All-reject decisions are
 * never signed — deny is the fail-safe direction — and a keyless project
 * takes a plain decision.
 */
export async function decide(input: {
  stream: RpcStub<Stream>;
  projectId: string;
  key: StoredApprovalKey | null;
  offset: number;
  payload: RequestedPayload;
  verdicts: readonly Verdict[];
  /** The human's rejection reason — rides the event (unsigned, like
   * rejections themselves) into each rejected fetch's 403 body. */
  reason?: string;
  signature?: string;
}): Promise<void> {
  const signs = input.key !== null && input.verdicts.includes("approve");
  let signature = input.signature;
  if (signature === undefined && signs) {
    signature = await signApprovalMessage(
      input.key!,
      messageFor(input.projectId, input.offset, input.payload, input.verdicts),
    );
  }
  // Cap to the contract's 1000-char bound so a long pasted reason survives
  // truncated instead of degrading to absent via the schema's catch.
  const reason = input.reason?.trim().slice(0, 1_000);
  await input.stream.append({
    type: EVENT.decided,
    payload: {
      approvalRequestEventOffset: input.offset,
      verdicts: [...input.verdicts],
      decidedBy: "human",
      ...(reason ? { reason } : {}),
      ...(signs ? { keyId: input.key!.keyId, signature } : {}),
    },
  });
}

/**
 * Page the project stream once and return every approval batch still open,
 * oldest first, plus the highest offset seen so a live tail resumes exactly
 * past it (no gap, no replay). Each carries the FIRST decision's verdicts
 * when one exists — such a batch shows as submitted (awaiting the door's
 * settles) rather than being offered a second, contradictory decision.
 *
 * Terminal: an all-reject decision (human or expiry), or a decision whose
 * every approved index has settled. A decision the door ignored (unsigned
 * with keys enrolled) never settles — the batch surfaces as submitted and
 * the settlement watch reports `unsettled` so front-ends can re-offer it.
 *
 * Both front-ends reconcile through this one function so terminal and machine
 * views can't derive "still open" differently.
 */
export async function reconcileBacklog(stream: RpcStub<Stream>): Promise<{
  open: Array<{
    offset: number;
    payload: RequestedPayload;
    submitted: boolean;
    verdicts: Verdict[] | null;
  }>;
  cursor: number;
}> {
  const requests = new Map<number, RequestedPayload>();
  const decisions = new Map<number, Verdict[]>(); // the FIRST decision per batch — the one the door honors
  const settledIndexes = new Map<number, Set<number>>();
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [EVENT.requested, EVENT.decided, EVENT.settled],
    });
    if (page.length === 0) break;
    for (const event of page) {
      cursor = event.offset;
      if (event.type === EVENT.requested) {
        requests.set(event.offset, event.payload as RequestedPayload);
        continue;
      }
      const payload = event.payload as {
        approvalRequestEventOffset?: number;
        verdicts?: Verdict[];
        index?: number;
      };
      const ref = payload.approvalRequestEventOffset;
      if (typeof ref !== "number") continue;
      if (event.type === EVENT.settled) {
        if (typeof payload.index !== "number") continue;
        const indexes = settledIndexes.get(ref) ?? new Set<number>();
        indexes.add(payload.index);
        settledIndexes.set(ref, indexes);
      } else if (
        !decisions.has(ref) &&
        Array.isArray(payload.verdicts) &&
        payload.verdicts.length === requests.get(ref)?.requests.length
      ) {
        // Pages arrive ascending, so the first decided we see IS the first by
        // offset — but only one the door would act on: a decision whose
        // verdict count doesn't match its batch is ignored by the door (it
        // keeps waiting), so honoring it here would hide a live hold.
        decisions.set(ref, payload.verdicts);
      }
    }
  }
  const now = Date.now();
  const open: Array<{
    offset: number;
    payload: RequestedPayload;
    submitted: boolean;
    verdicts: Verdict[] | null;
  }> = [];
  // Map iteration is insertion order — paged ascending — so this is oldest first.
  for (const [offset, payload] of requests) {
    const verdicts = decisions.get(offset) ?? null;
    if (verdicts !== null) {
      const approved = verdicts.flatMap((verdict, index) => (verdict === "approve" ? [index] : []));
      if (approved.length === 0) continue; // all-reject (human or expiry) — terminal
      const settled = settledIndexes.get(offset) ?? new Set<number>();
      if (approved.every((index) => settled.has(index))) continue; // fully released — terminal
      open.push({ offset, payload, submitted: true, verdicts });
      continue;
    }
    if (Date.parse(payload.expiresAt) <= now) continue;
    open.push({ offset, payload, submitted: false, verdicts: null });
  }
  return { open, cursor };
}

/**
 * How long to wait for the door to settle a decision. The door appends
 * `settled` per approved index only AFTER that released upstream `fetch`
 * finishes, so the window must outlast a slow-but-succeeding egress — a
 * shorter wait would misreport a valid decision as `unsettled`. Chunked into
 * bounded one-shot waits so no single RPC spans it.
 */
const SETTLEMENT_WINDOW_MS = 120_000;
const SETTLEMENT_CHUNK_MS = 25_000;

/**
 * Read back what the egress door did with a decided batch: released (an
 * outcome per approved index), rejected (an all-reject decision needs no
 * settles — including the door's own expiry decision, surfaced when it lands
 * mid-watch), or — if the approved indexes don't all settle in the window —
 * unsettled (an unverifiable decision is ignored server-side, so the hold
 * waits for a good one or expiry).
 */
export async function awaitSettlement(
  stream: RpcStub<Stream>,
  offset: number,
  verdicts: readonly Verdict[],
  windowMs = SETTLEMENT_WINDOW_MS,
): Promise<Settlement> {
  const approved = verdicts.flatMap((verdict, index) => (verdict === "approve" ? [index] : []));
  if (approved.length === 0) return { kind: "rejected", decidedBy: "human" };

  const forThisBatch = (candidate: StreamEvent) =>
    (candidate.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
    offset;
  const outcomes = new Map<number, { status: number | null; error: string | null }>();
  const deadline = Date.now() + windowMs;
  let cursor = offset;
  try {
    while (Date.now() < deadline && outcomes.size < approved.length) {
      let event: StreamEvent;
      try {
        event = await stream.waitForEvent({
          afterOffset: cursor,
          eventTypes: [EVENT.settled, EVENT.decided],
          predicate: forThisBatch,
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
      cursor = event.offset;
      if (event.type === EVENT.decided) {
        // The only decided event that matters mid-watch is the door's own
        // expiry — it means the decision we're watching was ignored and the
        // batch is dead. (Any other decided is a latecomer the door ignores.)
        if ((event.payload as { decidedBy?: string }).decidedBy === "expiry") {
          return { kind: "rejected", decidedBy: "expiry" };
        }
        continue;
      }
      const payload = event.payload as { index?: number; status?: number; error?: string };
      if (typeof payload.index !== "number") continue;
      outcomes.set(payload.index, {
        status: typeof payload.status === "number" ? payload.status : null,
        error: typeof payload.error === "string" ? payload.error : null,
      });
    }
    if (outcomes.size < approved.length) return { kind: "unsettled" };
    return {
      kind: "released",
      outcomes: approved.map((index) => ({ index, ...outcomes.get(index)! })),
    };
  } catch (error) {
    // A transport/protocol failure — NOT the deadline. Reporting this as
    // `unsettled` would re-enable the action and risk a contradictory decision
    // against a batch the door may already be settling; surface it as an error.
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
