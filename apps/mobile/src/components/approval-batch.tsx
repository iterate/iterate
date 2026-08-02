// Shared rendering of one egress-approval batch's rich detail, extracted
// verbatim from app/project/[projectId]/approvals.tsx (the #2372 batch-card
// rendering) so the TWO surfaces that show it — the approvals queue/history
// and the Notifications view's expandable rows — cannot drift. Three pieces:
//
// - ThreadContextLine: the thread's agent-maintained status as of the run.
// - ApprovalBatchBody: the requests / originating-script / policy block the
//   approvals card shows behind its expander and a notification row shows
//   when expanded. Owns the members/script sub-toggles (query-cache state,
//   the batch card's own precedent) and the one-shot script fetch.
// - RequestDetails (internal): one request's inspectable details plus its
//   per-index outcome on a resolved batch.
//
// - ApprovalBatchActions: Approve-all (Face ID signature) / Reject-with-
//   reason for a still-open batch — one decision, one signature, one event.
//
// The surfaces keep what is genuinely theirs: headline/summary rows,
// targeting, and top-level expansion state.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  approvalBodyForDisplay,
  decide,
  safeHost,
  scriptCodeForApproval,
  type HeldRequest,
  type RequestedPayload,
  type ResolvedBatch,
  type Verdict,
} from "../lib/approvals.ts";
import { approverKeyStatus, signWithApproverKey } from "../lib/approver.ts";
import { promptForRejectReason } from "../lib/reject-reason.ts";
import {
  SCRIPT_RUN_SETTLED_TYPE,
  SUMMARY_UPDATED_TYPE,
  threadContextForScriptRun,
} from "../lib/chat.ts";
import { getProjectItx } from "../lib/itx.ts";
import { colors, radius, spacing } from "../lib/theme.ts";
import { CodeBlock } from "./activity-card.tsx";

/**
 * The requests / originating-script / policy detail of one batch. `resolved`
 * is null while the batch is undecided — outcome lines and verdicts appear
 * once it isn't. `surface` keys the sub-toggle cache per mount surface, so
 * e.g. expanding the members list on the approvals screen doesn't expand it
 * inside a notification row too. `showThreadInfo` gates the provenance
 * header (Triggered by codemode · stream path · Open thread) and
 * `showScriptSource` the Script sub-expander: the Notifications expansion
 * wants both, the activity card wants NEITHER — it already lives inside
 * that thread and its Script tab already shows the code.
 */
export function ApprovalBatchBody({
  baseUrl,
  offset,
  payload,
  projectId,
  projectSlug,
  resolved,
  showScriptSource,
  showThreadInfo,
  surface,
}: {
  baseUrl: string;
  offset: number;
  payload: RequestedPayload;
  projectId: string;
  projectSlug: string;
  resolved: ResolvedBatch | null;
  showScriptSource: boolean;
  showThreadInfo: boolean;
  surface: string;
}) {
  const queryClient = useQueryClient();
  const single = payload.requests.length === 1;
  const detailsKey = ["approval-batch-body", projectId, offset, surface];
  const initialDetails = { members: false, script: false };
  const details = useQuery({
    queryKey: detailsKey,
    queryFn: async () => initialDetails,
    initialData: initialDetails,
    staleTime: Infinity,
  });
  const streamContext = payload.streamContext;
  const script = useQuery({
    queryKey:
      streamContext?.kind === "script-execution"
        ? [
            "approval-source-script",
            baseUrl,
            projectId,
            streamContext.streamPath,
            streamContext.scriptRunRequestedEventOffset,
          ]
        : ["approval-source-script", baseUrl, projectId, "none", offset],
    queryFn: async () => {
      if (streamContext?.kind !== "script-execution") {
        throw new Error("This approval has no codemode script source.");
      }
      const project = await getProjectItx(baseUrl, projectId);
      const event = await project.streams.get(streamContext.streamPath).getEvent({
        offset: streamContext.scriptRunRequestedEventOffset,
      });
      return scriptCodeForApproval(payload, event);
    },
    enabled: showScriptSource && details.data.script && streamContext?.kind === "script-execution",
    staleTime: Infinity,
  });
  const toggle = (section: "members" | "script") => {
    queryClient.setQueryData(detailsKey, { ...details.data, [section]: !details.data[section] });
  };

  return (
    <>
      {single ? (
        <RequestDetails
          outcome={
            resolved
              ? {
                  verdict: resolved.verdicts[0]!,
                  settle: resolved.outcomes[0] || null,
                  decidedBy: resolved.decidedBy,
                }
              : null
          }
          request={payload.requests[0]!}
          standalone
        />
      ) : (
        <View style={styles.detailSection}>
          <Pressable
            accessibilityRole="button"
            onPress={() => toggle("members")}
            style={styles.detailHeader}
          >
            <Text style={styles.chevron}>{details.data.members ? "▾" : "▸"}</Text>
            <Text style={styles.detailTitle}>Requests ({payload.requests.length})</Text>
          </Pressable>
          {details.data.members ? (
            <View style={styles.groupMembers}>
              {payload.requests.map((request, index) => (
                <View key={index} style={styles.memberCard}>
                  <RequestDetails
                    outcome={
                      resolved
                        ? {
                            verdict: resolved.verdicts[index]!,
                            settle: resolved.outcomes[index] || null,
                            decidedBy: resolved.decidedBy,
                          }
                        : null
                    }
                    request={request}
                    standalone={false}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}

      {streamContext?.kind === "script-execution" && (showThreadInfo || showScriptSource) ? (
        <View style={styles.detailSection}>
          {showThreadInfo ? (
            <View style={styles.sourceHeader}>
              <View style={styles.sourceCopy}>
                <Text style={styles.detailLabel}>Triggered by codemode</Text>
                <Text style={styles.sourceMeta} selectable>
                  {streamContext.streamPath} · script event #
                  {streamContext.scriptRunRequestedEventOffset}
                </Text>
              </View>
              {streamContext.streamPath.startsWith("/agents/") ? (
                <Pressable
                  accessibilityRole="link"
                  onPress={() =>
                    router.push({
                      pathname: "/project/[projectId]/chat",
                      params: { path: streamContext.streamPath, projectId, slug: projectSlug },
                    })
                  }
                  style={styles.threadLink}
                >
                  <Text style={styles.threadLinkText}>Open thread</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {showScriptSource ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => toggle("script")}
                style={styles.detailHeader}
              >
                <Text style={styles.chevron}>{details.data.script ? "▾" : "▸"}</Text>
                <Text style={styles.detailTitle}>Script</Text>
              </Pressable>
              {details.data.script ? (
                script.isPending ? (
                  <ActivityIndicator
                    accessibilityLabel="Loading"
                    color={colors.textMuted}
                    size="small"
                  />
                ) : script.isError ? (
                  <Text style={styles.error}>{script.error.message}</Text>
                ) : (
                  <CodeBlock language="typescript" muted={false} text={script.data} />
                )
              ) : null}
            </>
          ) : null}
        </View>
      ) : showThreadInfo && streamContext ? (
        <Text style={styles.sourceMeta}>Triggered from {streamContext.scopePath}</Text>
      ) : showThreadInfo ? (
        <Text style={styles.sourceMeta}>Source metadata unavailable for this request.</Text>
      ) : null}

      <View style={styles.policy}>
        <Text style={styles.detailLabel}>Approval policy</Text>
        <Text style={styles.policyDescription}>{payload.ruleDescription || payload.ruleKey}</Text>
        <Text style={styles.meta}>
          {payload.ruleKey} · expires {new Date(payload.expiresAt).toLocaleTimeString()}
        </Text>
      </View>
    </>
  );
}

/**
 * Decide a still-open batch from wherever its detail renders: ONE decision
 * covering every request — approve all behind the Face ID signature, or
 * reject all with an optional typed reason that rides back to the calling
 * script's 403 body. Moved from the retired Approvals screen's respond
 * mutation, verbatim: always sign approvals (an unsigned decision a keyed
 * project ignores would strand the hold as "submitted" with no visible
 * retry), and rejections never sign — deny is the fail-safe direction.
 * `onDecided` lets the mounting surface refetch whatever derived the open
 * state.
 */
export function ApprovalBatchActions({
  baseUrl,
  offset,
  onDecided,
  payload,
  projectId,
}: {
  baseUrl: string;
  offset: number;
  onDecided: () => void;
  payload: RequestedPayload;
  projectId: string;
}) {
  const key = useQuery({
    queryKey: ["approver-key-status", projectId, baseUrl],
    queryFn: () => approverKeyStatus(baseUrl, projectId),
  });
  const enrolledKey = key.data?.kind === "enrolled" ? key.data.key : null;
  const respond = useMutation({
    mutationFn: async (decision: "approve" | "reject"): Promise<"decided" | "cancelled"> => {
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get("/");
      const verdicts = payload.requests.map(
        (): Verdict => (decision === "approve" ? "approve" : "reject"),
      );
      if (decision === "reject") {
        const reason = await promptForRejectReason(payload.requests.length);
        if (reason === null) return "cancelled"; // leave the batch held
        await decide({
          stream,
          projectId,
          offset,
          payload,
          verdicts,
          reason: reason || undefined,
          sign: null,
        });
        return "decided";
      }
      if (!enrolledKey) throw new Error("Enroll this device before approving.");
      await decide({
        stream,
        projectId,
        offset,
        payload,
        verdicts,
        sign: (message) => signWithApproverKey(projectId, message),
      });
      return "decided";
    },
    onSuccess: (outcome) => {
      if (outcome === "decided") onDecided();
    },
  });
  // Keeps the buttons down between the decide landing and the invalidated
  // batch query refetching the record — otherwise they'd briefly re-enable
  // and could solicit a second Face ID. A cancelled reject prompt does NOT
  // count: the batch is still held and still actionable.
  const decided = respond.data === "decided";
  const single = payload.requests.length === 1;
  return (
    <>
      {respond.isError ? <Text style={styles.error}>{String(respond.error.message)}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          style={[styles.button, styles.reject]}
          disabled={respond.isPending || decided}
          onPress={() => respond.mutate("reject")}
        >
          <Text style={styles.rejectText}>{single ? "Reject" : "Reject all"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={[styles.button, styles.approve, enrolledKey === null && styles.buttonDisabled]}
          disabled={respond.isPending || decided || enrolledKey === null}
          onPress={() => respond.mutate("approve")}
        >
          <Text style={styles.approveText}>
            {respond.isPending
              ? "Signing…"
              : decided
                ? "Decided"
                : enrolledKey === null
                  ? "Enroll to approve"
                  : single
                    ? "Approve (Face ID)"
                    : `Approve all ${payload.requests.length} (Face ID)`}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

/**
 * "What was this run even doing?" — the thread's agent-maintained STATUS as
 * of this script run (threadContextForScriptRun folds `agent/summary-updated`
 * through the run's own settlement), pinned to the card so the queue and
 * history read without opening each thread. A snapshot deliberately, not live
 * status: the fold is bounded by immutable history, so it works identically
 * for open and settled batches. The status renders IN FULL (it wraps — a
 * clipped status answers nothing) and taps through to the thread. Statusless
 * threads render no line at all — same as while the one-shot fetch is
 * pending or failed, which is what keeps the card spinner-free.
 */
export function ThreadContextLine({
  baseUrl,
  executionId,
  projectId,
  projectSlug,
  streamPath,
}: {
  baseUrl: string;
  executionId: string;
  projectId: string;
  projectSlug: string;
  streamPath: string;
}) {
  const context = useQuery({
    queryKey: ["approval-thread-context", baseUrl, projectId, streamPath, executionId],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get(streamPath);
      // Summary events are sparse (a handful per turn), and getEvents
      // filters by type in SQL before applying its page limit — so even a
      // very long thread reads as one small page; the loop is only for the
      // pathological >500-status thread.
      const events: StreamEvent[] = [];
      let cursor = 0;
      while (true) {
        const page = await stream.getEvents({
          afterOffset: cursor,
          eventTypes: [SUMMARY_UPDATED_TYPE, SCRIPT_RUN_SETTLED_TYPE],
        });
        if (page.length === 0) break;
        events.push(...page);
        cursor = page.at(-1)!.offset;
      }
      return threadContextForScriptRun(events, { executionId });
    },
    // Cache forever only once the fold window is CLOSED (the run's settle
    // event was in view) — then the result, status or null, is immutable.
    // Before that it is provisional: agents Promise.all their status append
    // with the work itself, so a held approval can render this card before
    // the status lands; a forever-cached premature null would never heal.
    staleTime: (query) => (query.state.data?.settled ? Infinity : 5_000),
    refetchInterval: (query) => (query.state.data?.settled ? false : 5_000),
  });
  const status = context.data?.status;
  if (!status) return null;
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        router.push({
          pathname: "/project/[projectId]/chat",
          params: { path: streamPath, projectId, slug: projectSlug },
        })
      }
      style={styles.threadContext}
    >
      <Text style={styles.threadContextText}>
        <Text style={styles.threadContextName}>{streamPath.replace(/^\/agents\//, "")}</Text>
        {` · ${[status.title, status.activity].filter(Boolean).join(" — ")}`}
      </Text>
    </Pressable>
  );
}

/**
 * One held request's inspectable details — URL, spent secrets, body hash and
 * bounded body preview — plus its per-index outcome on a resolved batch.
 * Body previews render inline (no per-request toggle): the batch expander
 * above is the reveal step.
 */
function RequestDetails({
  outcome,
  request,
  standalone,
}: {
  outcome: {
    verdict: Verdict;
    settle: { status: number | null; error: string | null } | null;
    decidedBy: "human" | "expiry";
  } | null;
  request: HeldRequest;
  standalone: boolean;
}) {
  const body = approvalBodyForDisplay(request);
  return (
    <View style={{ gap: 4 }}>
      {standalone ? null : (
        <Text style={styles.memberHeadline}>
          {request.method} {safeHost(request.url)}
        </Text>
      )}
      {outcome ? (
        <Text style={styles.outcomeDetail}>
          {outcome.verdict === "reject"
            ? outcome.decidedBy === "expiry"
              ? "Expired"
              : "Rejected"
            : outcome.settle === null
              ? "Approved — awaiting the egress door…"
              : outcome.settle.error !== null
                ? `Delivery failed · ${outcome.settle.error}`
                : `Upstream ${outcome.settle.status || "status unavailable"}`}
        </Text>
      ) : null}
      <Text style={styles.url} selectable>
        {request.url}
      </Text>
      {request.secretPaths.length > 0 ? (
        <Text style={styles.secretLine}>spends {request.secretPaths.join(", ")}</Text>
      ) : null}
      <Text style={styles.meta} selectable>
        body sha256: {request.body?.sha256 || "none"}
      </Text>
      {body ? (
        <View style={styles.detailSection}>
          <Text style={styles.detailTitle}>
            {body.truncated ? "Request body prefix" : "Request body"}
            {request.body?.encoding === "base64" || body.truncated ? (
              <Text style={styles.detailHint}>
                {"  "}
                {[
                  request.body?.encoding === "base64" ? "base64" : "",
                  body.truncated
                    ? `64 KiB cap · ${body.originalByteLength?.toLocaleString() || "unknown"} bytes total`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ) : null}
          </Text>
          {body.language === "json" ? (
            <CodeBlock language="json" muted={false} text={body.text} />
          ) : (
            <ScrollView style={styles.bodyScroller} nestedScrollEnabled>
              <Text style={styles.bodyText} selectable>
                {body.text}
              </Text>
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  outcomeDetail: { color: colors.textMuted, fontSize: 11 },
  memberHeadline: { color: colors.text, fontSize: 13, fontWeight: "600" },
  url: { color: colors.textMuted, fontSize: 12, fontFamily: "Menlo", flexShrink: 1 },
  secretLine: { color: colors.working, fontSize: 12 },
  meta: { color: colors.textFaint, fontSize: 11 },
  detailSection: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  detailHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
    minHeight: 32,
  },
  chevron: { color: colors.textFaint, fontSize: 12, textAlign: "center", width: 14 },
  detailTitle: { color: colors.text, flex: 1, fontSize: 13, fontWeight: "600" },
  detailHint: { color: colors.textFaint, fontFamily: "Menlo", fontSize: 10 },
  bodyScroller: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    maxHeight: 260,
  },
  bodyText: {
    color: colors.textMuted,
    fontFamily: "Menlo",
    fontSize: 11,
    lineHeight: 17,
    padding: spacing.sm,
  },
  threadContext: { justifyContent: "center", minHeight: 24 },
  threadContextText: { color: colors.textMuted, fontSize: 12 },
  threadContextName: { color: colors.accent, fontWeight: "600" },
  sourceHeader: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  sourceCopy: { flex: 1, gap: 2 },
  detailLabel: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  sourceMeta: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 10, flexShrink: 1 },
  threadLink: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  threadLinkText: { color: colors.accent, fontSize: 11, fontWeight: "600" },
  policy: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    gap: 3,
    marginTop: spacing.sm,
    padding: spacing.sm,
  },
  policyDescription: { color: colors.text, fontSize: 13 },
  groupMembers: {
    gap: spacing.sm,
  },
  memberCard: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  button: {
    flex: 1,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: "center",
  },
  reject: { borderColor: colors.danger, borderWidth: 1 },
  rejectText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  approve: { backgroundColor: colors.accent },
  buttonDisabled: { opacity: 0.4 },
  approveText: { color: colors.background, fontSize: 14, fontWeight: "600" },
});
