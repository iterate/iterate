// Human-in-the-loop egress approvals, phone edition — protocol logic ported
// from packages/iterate/src/approve-core.ts (the `iterate approve` CLI's
// UI-free half) with one divergence: signing is dependency-injected (a
// `sign` callback) instead of importing approval-keys.ts, which is
// Node-only (fs, os, swiftc). That keeps this file itself Expo-free, so the
// live e2e drives it from Node, and the UI screen binds `sign` to approver.ts's
// Face-ID-gated signer.
//
// No custom abstraction beyond that: reconcileBacklog/awaitSettlement are
// copied near-verbatim since they're already UI-free, generic, and this is
// the second real caller (not a premature one).

import type { RpcStub } from "capnweb";
import type { Stream, StreamEvent } from "iterate/sdk/itx/react";
import {
  buildApprovalMessage,
  type HumanApprovalRequestedPayload,
} from "../../../os/src/domains/projects/egress-approvals.ts";

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

export function approvalBodyForDisplay(payload: RequestedPayload): {
  language: "json" | "text";
  text: string;
} | null {
  if (payload.body === null) return null;
  if (payload.body === undefined) {
    return payload.bodyPreview === null ? null : { language: "text", text: payload.bodyPreview };
  }
  if (payload.body.encoding === "base64") {
    return { language: "text", text: payload.body.content };
  }
  try {
    JSON.parse(payload.body.content);
    return { language: "json", text: payload.body.content };
  } catch {
    return { language: "text", text: payload.body.content };
  }
}

export function scriptCodeForApproval(
  payload: RequestedPayload,
  event: StreamEvent | undefined,
): string {
  const source = payload.source;
  if (source?.kind !== "script-execution") {
    throw new Error("This approval was not triggered by a codemode script.");
  }
  if (
    event === undefined ||
    event.type !== "events.iterate.com/capability-host/script-run-requested" ||
    event.path !== source.streamPath ||
    event.offset !== source.scriptRunRequestedEventOffset ||
    event.payload?.executionId !== source.executionId ||
    typeof event.payload.code !== "string"
  ) {
    throw new Error("The approval's source script event could not be verified.");
  }
  return event.payload.code;
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

/** What the egress door did after a grant/reject. */
export type Settlement =
  | { kind: "released"; status: number }
  | { kind: "delivery-failed"; error: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unsettled" }
  | { kind: "error"; message: string };

/**
 * Grant one held request. `sign` is null for a keyless project (plain
 * grant); otherwise it's called with the canonical message and must return
 * the enrolled key's signature — approver.ts's signWithApproverKey, which
 * prompts Face ID.
 */
export async function grant(input: {
  stream: RpcStub<Stream>;
  projectId: string;
  offset: number;
  payload: RequestedPayload;
  sign: ((message: Uint8Array) => Promise<{ keyId: string; signature: string }>) | null;
}): Promise<void> {
  const signed = input.sign
    ? await input.sign(messageFor(input.projectId, input.offset, input.payload))
    : null;
  await input.stream.append({
    type: EVENT.granted,
    payload: {
      approvalRequestEventOffset: input.offset,
      ...(signed ? { keyId: signed.keyId, signature: signed.signature } : {}),
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

export type OpenRequest = { offset: number; payload: RequestedPayload; submitted: boolean };

export type ResolvedRequest = {
  offset: number;
  payload: RequestedPayload;
  resolutionEventOffset: number;
  outcome:
    | { decision: "approved"; upstreamStatus: number | null; deliveryError: string | null }
    | { decision: "rejected"; reason: string };
};

/** Put the approval opened from a notification first without disturbing the queue's other items. */
export function focusOpenRequest(
  requests: OpenRequest[],
  targetOffset: number | null,
): OpenRequest[] {
  if (targetOffset === null) return requests;
  const target = requests.find((request) => request.offset === targetOffset);
  if (!target) return requests;
  return [target, ...requests.filter((request) => request.offset !== targetOffset)];
}

/**
 * The pure reduction: every approval request still open, oldest first, from
 * a flat batch of requested/granted/settled/rejected events (order
 * doesn't matter — offsets do). See approve-core.ts's reconcileBacklog for
 * the terminal-state reasoning this mirrors verbatim. Two callers: the
 * approvals screen derives this from its already-fetched query data
 * (events.data → useMemo, no separate paging call); reconcileBacklog below
 * pages a live stream for the CLI/e2e, which don't hold a local copy.
 */
export function deriveOpenRequests(events: readonly StreamEvent[]): OpenRequest[] {
  const requests = new Map<number, RequestedPayload>();
  const settled = new Set<number>();
  const firstResolution = new Map<number, "granted" | "rejected">();
  for (const event of events) {
    if (event.type === EVENT.requested) {
      requests.set(event.offset, event.payload as RequestedPayload);
      continue;
    }
    const ref = (event.payload as { approvalRequestEventOffset?: number })
      .approvalRequestEventOffset;
    if (typeof ref !== "number") continue;
    if (event.type === EVENT.settled) settled.add(ref);
    else if (event.type === EVENT.granted || event.type === EVENT.rejected) {
      if (!firstResolution.has(ref)) {
        firstResolution.set(ref, event.type === EVENT.granted ? "granted" : "rejected");
      }
    }
  }
  const now = Date.now();
  return [...requests]
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
}

/** Pair recent terminal decisions back to their requests so resolved cards retain provenance. */
export function deriveRecentResolvedRequests(
  events: readonly StreamEvent[],
  limit: number,
): ResolvedRequest[] {
  const requests = new Map<number, RequestedPayload>();
  const firstDecision = new Map<number, "granted" | "rejected">();
  const resolved = new Map<number, ResolvedRequest>();

  for (const event of [...events].sort((left, right) => left.offset - right.offset)) {
    if (event.type === EVENT.requested) {
      requests.set(event.offset, event.payload as RequestedPayload);
      continue;
    }

    const payload = event.payload as {
      approvalRequestEventOffset?: number;
      error?: string;
      reason?: string;
      status?: number;
    };
    const requestOffset = payload.approvalRequestEventOffset;
    if (typeof requestOffset !== "number") continue;

    if (event.type === EVENT.granted) {
      if (!firstDecision.has(requestOffset)) firstDecision.set(requestOffset, "granted");
      continue;
    }

    if (event.type === EVENT.rejected) {
      if (!firstDecision.has(requestOffset)) firstDecision.set(requestOffset, "rejected");
      if (firstDecision.get(requestOffset) !== "rejected") continue;
      const request = requests.get(requestOffset);
      if (!request) continue;
      resolved.set(requestOffset, {
        offset: requestOffset,
        payload: request,
        resolutionEventOffset: event.offset,
        outcome: { decision: "rejected", reason: payload.reason || "human" },
      });
      continue;
    }

    if (event.type === EVENT.settled) {
      const request = requests.get(requestOffset);
      if (!request) continue;
      resolved.set(requestOffset, {
        offset: requestOffset,
        payload: request,
        resolutionEventOffset: event.offset,
        outcome: {
          decision: "approved",
          deliveryError: typeof payload.error === "string" ? payload.error : null,
          upstreamStatus: typeof payload.status === "number" ? payload.status : null,
        },
      });
    }
  }

  return [...resolved.values()]
    .sort((left, right) => right.resolutionEventOffset - left.resolutionEventOffset)
    .slice(0, limit);
}

/**
 * Page the project stream once and return deriveOpenRequests' result, plus
 * the highest offset seen so a live tail resumes exactly past it. The CLI's
 * connect-fresh entrypoint — no local event cache to derive from.
 */
export async function reconcileBacklog(
  stream: RpcStub<Stream>,
): Promise<{ open: OpenRequest[]; cursor: number }> {
  const events: StreamEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({
      afterOffset: cursor,
      eventTypes: [EVENT.requested, EVENT.granted, EVENT.settled, EVENT.rejected],
    });
    if (page.length === 0) break;
    events.push(...page);
    cursor = page.at(-1)!.offset;
  }
  return { open: deriveOpenRequests(events), cursor };
}

function settledOutcome(
  event: StreamEvent,
): Extract<Settlement, { kind: "released" | "delivery-failed" }> {
  const outcome = event.payload as { status?: number; error?: string };
  return outcome.error !== undefined
    ? { kind: "delivery-failed", error: outcome.error }
    : { kind: "released", status: outcome.status ?? 0 };
}

const SETTLEMENT_WINDOW_MS = 120_000;
const SETTLEMENT_CHUNK_MS = 25_000;

/** Read back what the egress door did with a request. See approve-core.ts's awaitSettlement for the full reasoning this mirrors verbatim. */
export async function awaitSettlement(
  stream: RpcStub<Stream>,
  offset: number,
  windowMs = SETTLEMENT_WINDOW_MS,
): Promise<Settlement> {
  const forThisRequest = (candidate: StreamEvent) =>
    (candidate.payload as { approvalRequestEventOffset?: number }).approvalRequestEventOffset ===
    offset;

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

    const settled = await waitUntil([EVENT.settled], Date.now() + windowMs);
    return settled === null
      ? { kind: "rejected", reason: (event.payload as { reason?: string }).reason ?? "human" }
      : settledOutcome(settled);
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
