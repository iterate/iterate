// Human-in-the-loop egress approvals, phone edition — protocol logic ported
// from packages/iterate/src/approve-core.ts (the `iterate approve` CLI's
// UI-free half) with one divergence: signing is dependency-injected (a
// `sign` callback) instead of importing approval-keys.ts, which is
// Node-only (fs, os, swiftc). That keeps this file itself Expo-free, so the
// live e2e drives it from Node, and the UI screen binds `sign` to approver.ts's
// Face-ID-gated signer.
//
// The unit of approval is the BATCH: one `human-approval-requested` event
// carries 1..n held requests (the egress door coalesces a script run's
// concurrent burst; a lone request is a batch of one), and ONE signed
// `human-approval-decided` event answers it with a verdict per index. The
// door honors the FIRST decision — approving 12 requests is one Face ID,
// one signature, one append.

import type { RpcStub } from "capnweb";
import type { Stream, StreamEvent } from "iterate/sdk/itx/react";
import {
  buildApprovalMessage,
  type HeldRequest,
  type HumanApprovalRequestedPayload,
} from "../../../os/src/domains/projects/egress-approvals.ts";

export const EVENT = {
  requested: "events.iterate.com/project/human-approval-requested",
  decided: "events.iterate.com/project/human-approval-decided",
  settled: "events.iterate.com/project/human-approval-settled",
  keyAdded: "events.iterate.com/project/human-approval-key-added",
  keyRevoked: "events.iterate.com/project/human-approval-key-revoked",
  presented: "events.iterate.com/project/approval-presented",
} as const;

export type RequestedPayload = HumanApprovalRequestedPayload;
export type { HeldRequest };
export type Verdict = "approve" | "reject";

/** The request's host for display — falls back to the raw URL when unparseable. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function approvalBodyForDisplay(request: HeldRequest): {
  language: "json" | "text";
  originalByteLength: number | null;
  text: string;
  truncated: boolean;
} | null {
  if (request.body === null || request.body === undefined) return null;
  const originalByteLength =
    request.body.originalByteLength === undefined ? null : request.body.originalByteLength;
  if (request.body.encoding === "base64") {
    return {
      language: "text",
      originalByteLength,
      text: request.body.content,
      truncated: request.body.truncated,
    };
  }
  try {
    JSON.parse(request.body.content);
    return {
      language: "json",
      originalByteLength,
      text: request.body.content,
      truncated: request.body.truncated,
    };
  } catch {
    return {
      language: "text",
      originalByteLength,
      text: request.body.content,
      truncated: request.body.truncated,
    };
  }
}

export function scriptCodeForApproval(
  payload: RequestedPayload,
  event: StreamEvent | undefined,
): string {
  const streamContext = payload.streamContext;
  if (streamContext?.kind !== "script-execution") {
    throw new Error("This approval was not triggered by a codemode script.");
  }
  if (
    event === undefined ||
    event.type !== "events.iterate.com/capability-host/script-run-requested" ||
    event.path !== streamContext.streamPath ||
    event.offset !== streamContext.scriptRunRequestedEventOffset ||
    event.payload?.executionId !== streamContext.executionId ||
    typeof event.payload.code !== "string"
  ) {
    throw new Error("The approval's source script event could not be verified.");
  }
  return event.payload.code;
}

/** The canonical bytes a decision for this batch signs over (approval.v2). */
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

/** "3x gmail.googleapis.com, 1x api.stripe.com" — busiest host first, the same
 * host-only summary shape the server's push body uses. */
export function hostBreakdown(requests: readonly { url: string }[]): string {
  const counts = new Map<string, number>();
  for (const request of requests) {
    const host = safeHost(request.url);
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([hostA, countA], [hostB, countB]) => countB - countA || hostA.localeCompare(hostB))
    .map(([host, count]) => `${count}x ${host}`)
    .join(", ");
}

/**
 * Decide one held batch: ONE event, ONE signature, a verdict per index.
 * `sign` is null for a keyless project (plain decision); otherwise it's
 * called with the canonical message and must return the enrolled key's
 * signature — approver.ts's signWithApproverKey, which prompts Face ID.
 * All-reject decisions never sign: deny is the fail-safe direction. A
 * rejection `reason` rides the event (unsigned, like rejections themselves)
 * and lands in each rejected fetch's 403 body for the calling agent.
 */
export async function decide(input: {
  stream: RpcStub<Stream>;
  projectId: string;
  offset: number;
  payload: RequestedPayload;
  verdicts: readonly Verdict[];
  reason?: string;
  sign: ((message: Uint8Array) => Promise<{ keyId: string; signature: string }>) | null;
}): Promise<void> {
  const signs = input.sign !== null && input.verdicts.includes("approve");
  const signed = signs
    ? await input.sign!(messageFor(input.projectId, input.offset, input.payload, input.verdicts))
    : null;
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
      ...(signed ? { keyId: signed.keyId, signature: signed.signature } : {}),
    },
  });
}

/** One held batch still awaiting the door: undecided (actionable), or decided
 * but not fully settled (`submitted` — show it awaiting, never re-offer). */
export type OpenBatch = {
  offset: number;
  payload: RequestedPayload;
  submitted: boolean;
  verdicts: Verdict[] | null;
};

/** One decided batch for the Recent list, with whatever outcomes have landed. */
export type ResolvedBatch = {
  offset: number;
  payload: RequestedPayload;
  /** The decided event's offset — what Recent orders by. */
  resolutionEventOffset: number;
  verdicts: Verdict[];
  decidedBy: "human" | "expiry";
  /** The human's stated rejection reason, when one was given. */
  reason: string | null;
  /** Per-index: a settle outcome for approved indexes (null until it lands), null for rejected ones. */
  outcomes: Array<{ status: number | null; error: string | null } | null>;
  /** "Approved" / "Rejected" / "Expired" / "9 approved · 3 rejected" — the header badge. */
  decisionSummary: string;
};

/**
 * The pure reduction: every approval batch still open, oldest first, from a
 * flat event batch (order doesn't matter — offsets do). The door honors the
 * FIRST decided event per batch: an all-reject decision (human or expiry) is
 * terminal, a decision with approvals stays visible as `submitted` until
 * every approved index settles. Two callers: the approvals screen derives
 * this from its already-fetched query data (events.data → useMemo);
 * reconcileBacklog below pages a live stream for the e2e, which doesn't hold
 * a local copy.
 */
export function deriveOpenBatches(events: readonly StreamEvent[]): OpenBatch[] {
  const { requests, decisions, settledIndexes } = indexApprovalEvents(events);
  const now = Date.now();
  const open: OpenBatch[] = [];
  for (const [offset, payload] of [...requests].sort(([a], [b]) => a - b)) {
    const decision = decisions.get(offset);
    if (decision) {
      const approved = decision.verdicts.flatMap((verdict, index) =>
        verdict === "approve" ? [index] : [],
      );
      if (approved.length === 0) continue; // all-reject — terminal
      const settled = settledIndexes.get(offset) || new Set<number>();
      if (approved.every((index) => settled.has(index))) continue; // fully released
      open.push({ offset, payload, submitted: true, verdicts: decision.verdicts });
      continue;
    }
    if (Date.parse(payload.expiresAt) <= now) continue;
    open.push({ offset, payload, submitted: false, verdicts: null });
  }
  return open;
}

/** Pair recent decisions back to their batches so resolved cards retain provenance. */
export function deriveRecentResolvedBatches(
  events: readonly StreamEvent[],
  limit: number,
): ResolvedBatch[] {
  const { requests, decisions, settles } = indexApprovalEvents(events);
  const resolved: ResolvedBatch[] = [];
  for (const [offset, decision] of decisions) {
    const payload = requests.get(offset);
    if (!payload) continue;
    const outcomes = decision.verdicts.map((verdict, index) => {
      if (verdict !== "approve") return null;
      const settle = settles.get(offset)?.get(index);
      return settle === undefined ? null : settle;
    });
    const approved = decision.verdicts.filter((verdict) => verdict === "approve").length;
    const rejected = decision.verdicts.length - approved;
    const decisionSummary =
      decision.decidedBy === "expiry"
        ? "Expired"
        : rejected === 0
          ? "Approved"
          : approved === 0
            ? "Rejected"
            : `${approved} approved · ${rejected} rejected`;
    resolved.push({
      offset,
      payload,
      resolutionEventOffset: decision.eventOffset,
      verdicts: decision.verdicts,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
      outcomes,
      decisionSummary,
    });
  }
  return resolved
    .sort((left, right) => right.resolutionEventOffset - left.resolutionEventOffset)
    .slice(0, limit);
}

/**
 * One batch's full detail, addressed by its requested-event offset — what
 * the Notifications screen's inline expansion renders. `resolved` is null
 * while the batch awaits its decision; `complete` is the caller's caching
 * contract (mirrors threadContextForScriptRun's `settled`): true once the
 * decision AND every approved index's settle are in view, after which the
 * history is immutable and may be cached forever. Null when the requested
 * event itself is not in the given events (wrong offset, or a stream page
 * that missed it).
 */
export function deriveBatchDetail(
  events: readonly StreamEvent[],
  offset: number,
): { payload: RequestedPayload; resolved: ResolvedBatch | null; complete: boolean } | null {
  const resolved = deriveRecentResolvedBatches(events, Number.MAX_SAFE_INTEGER).find(
    (batch) => batch.offset === offset,
  );
  if (resolved) {
    return {
      payload: resolved.payload,
      resolved,
      complete: resolved.verdicts.every(
        (verdict, index) => verdict === "reject" || resolved.outcomes[index] !== null,
      ),
    };
  }
  const requested = events.find(
    (event) => event.offset === offset && event.type === EVENT.requested,
  );
  if (requested === undefined) return null;
  return { payload: requested.payload as RequestedPayload, resolved: null, complete: false };
}

/** Put the batch opened from a notification first without disturbing the queue's other items. */
export function focusOpenBatch(batches: OpenBatch[], targetOffset: number | null): OpenBatch[] {
  if (targetOffset === null) return batches;
  const target = batches.find((batch) => batch.offset === targetOffset);
  if (!target) return batches;
  return [target, ...batches.filter((batch) => batch.offset !== targetOffset)];
}

/**
 * Page the project stream once and return deriveOpenBatches' result, plus
 * the highest offset seen so a live tail resumes exactly past it. The e2e's
 * connect-fresh entrypoint — no local event cache to derive from.
 */
export async function reconcileBacklog(
  stream: RpcStub<Stream>,
): Promise<{ open: OpenBatch[]; cursor: number }> {
  const events: StreamEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [EVENT.requested, EVENT.decided, EVENT.settled],
    });
    if (page.length === 0) break;
    events.push(...page);
    cursor = page.at(-1)!.offset;
  }
  return { open: deriveOpenBatches(events), cursor };
}

/** What the egress door did after a decision. */
export type Settlement =
  | {
      kind: "released";
      outcomes: Array<{ index: number; status: number | null; error: string | null }>;
    }
  | { kind: "rejected"; decidedBy: "human" | "expiry" }
  | { kind: "unsettled" }
  | { kind: "error"; message: string };

const SETTLEMENT_WINDOW_MS = 120_000;
const SETTLEMENT_CHUNK_MS = 25_000;

/** Read back what the egress door did with a decided batch. See
 * approve-core.ts's awaitSettlement for the full reasoning this mirrors. */
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
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** One shared pass over the approval vocabulary: batches, first decisions,
 * and per-index settles, keyed by the batch's requested event offset. */
function indexApprovalEvents(events: readonly StreamEvent[]) {
  const requests = new Map<number, RequestedPayload>();
  const decisions = new Map<
    number,
    {
      verdicts: Verdict[];
      decidedBy: "human" | "expiry";
      reason: string | null;
      eventOffset: number;
    }
  >();
  const settles = new Map<number, Map<number, { status: number | null; error: string | null }>>();
  const settledIndexes = new Map<number, Set<number>>();
  for (const event of [...events].sort((left, right) => left.offset - right.offset)) {
    if (event.type === EVENT.requested) {
      requests.set(event.offset, event.payload as RequestedPayload);
      continue;
    }
    const payload = event.payload as {
      approvalRequestEventOffset?: number;
      verdicts?: Verdict[];
      decidedBy?: string;
      reason?: string;
      index?: number;
      status?: number;
      error?: string;
    };
    const ref = payload.approvalRequestEventOffset;
    if (typeof ref !== "number") continue;
    if (event.type === EVENT.decided) {
      // Ascending order means the first decided we KEEP is the one the door
      // honors — which requires mirroring the door's rule of ignoring a
      // decision whose verdict count doesn't match its batch (the door keeps
      // waiting on those; treating one as terminal here would hide a live
      // hold from the screen).
      if (
        !decisions.has(ref) &&
        Array.isArray(payload.verdicts) &&
        payload.verdicts.length === requests.get(ref)?.requests.length
      ) {
        decisions.set(ref, {
          verdicts: payload.verdicts,
          decidedBy: payload.decidedBy === "expiry" ? "expiry" : "human",
          reason: typeof payload.reason === "string" ? payload.reason : null,
          eventOffset: event.offset,
        });
      }
    } else if (event.type === EVENT.settled && typeof payload.index === "number") {
      const perIndex = settles.get(ref) || new Map();
      perIndex.set(payload.index, {
        status: typeof payload.status === "number" ? payload.status : null,
        error: typeof payload.error === "string" ? payload.error : null,
      });
      settles.set(ref, perIndex);
      const indexes = settledIndexes.get(ref) || new Set<number>();
      indexes.add(payload.index);
      settledIndexes.set(ref, indexes);
    }
  }
  return { requests, decisions, settles, settledIndexes };
}
