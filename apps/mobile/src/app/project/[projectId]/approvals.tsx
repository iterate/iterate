// Human-in-the-loop egress approvals for one project. Enroll this device
// (generates a P-256 "software" approval key — same kind
// packages/iterate/src/approval-keys.ts uses for CI/non-Mac machines — and
// keeps the private half in the Keychain behind Face ID / Touch ID), then
// decide held BATCHES as they arrive live: one card per batch (a lone
// request is a batch of one), one Face ID, one signed decision covering
// every request. See apps/mobile/src/lib/approvals.ts for the protocol.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CodeBlock } from "../../../components/activity-card.tsx";
import { promptForRejectReason } from "../../../lib/reject-reason.ts";
import {
  approverKeyStatus,
  enrollApproverKey,
  reenrollApproverKey,
  signWithApproverKey,
} from "../../../lib/approver.ts";
import {
  deriveOpenBatches,
  deriveRecentResolvedBatches,
  EVENT,
  focusOpenBatch,
  approvalBodyForDisplay,
  decide,
  hostBreakdown,
  safeHost,
  scriptCodeForApproval,
  type HeldRequest,
  type OpenBatch,
  type RequestedPayload,
  type ResolvedBatch,
  type Verdict,
} from "../../../lib/approvals.ts";
import {
  ASSISTANT_MESSAGE_TYPE,
  lastVisibleMessageAtOrBefore,
  USER_MESSAGE_TYPE,
} from "../../../lib/chat.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

const APPROVAL_EVENT_TYPES = [EVENT.requested, EVENT.decided, EVENT.settled];

export default function ApprovalsScreen() {
  const { projectId, approvalRequestEventOffset, slug } = useLocalSearchParams<{
    projectId: string;
    approvalRequestEventOffset?: string;
    slug?: string;
  }>();
  const parsedTargetOffset = Number(approvalRequestEventOffset);
  const targetOffset =
    Number.isSafeInteger(parsedTargetOffset) && parsedTargetOffset > 0 ? parsedTargetOffset : null;

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;

  // The JOIN of the local key and the project's enrolled-key state: a
  // locally present key the project has revoked must NOT offer Approve (the
  // door ignores its signatures — batches would strand as "submitted").
  const key = useQuery({
    queryKey: ["approver-key-status", projectId, baseUrl],
    queryFn: () => approverKeyStatus(baseUrl!, projectId),
    enabled: baseUrl !== undefined,
  });
  const enrolledKey = key.data?.kind === "enrolled" ? key.data.key : null;

  const enroll = useMutation({
    mutationFn: async () => {
      if (key.data?.kind === "revoked") {
        // Recovering a revoked device is a deliberate act: fresh keypair,
        // never a resurrection of the revoked keyId.
        return await reenrollApproverKey(baseUrl!, projectId, "This iPhone");
      }
      const info = await enrollApproverKey(projectId, "This iPhone");
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get("/");
      await stream.append({
        type: EVENT.keyAdded,
        payload: { keyId: info.keyId, publicKey: info.publicKey, label: info.label },
      });
      return info;
    },
    onSuccess: () => key.refetch(),
  });

  const events = useLiveEvents({
    queryKey: ["approval-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await project.streams.get("/").getEvents({ eventTypes: APPROVAL_EVENT_TYPES });
    },
    enabled: baseUrl !== undefined,
    eventTypes: APPROVAL_EVENT_TYPES,
    projectId,
    streamPath: "/",
  });

  const open = useMemo(
    () => focusOpenBatch(deriveOpenBatches(events.data || []), targetOffset),
    [events.data, targetOffset],
  );
  const recent = useMemo(() => deriveRecentResolvedBatches(events.data || [], 5), [events.data]);

  // ONE decision per batch: approve all or reject all. The approval.v2
  // message binds every request plus the verdicts, so a 12-request batch is
  // still one Face ID, one signature, one append. Rejecting first asks for an
  // optional reason, which rides the decided event back to the calling
  // script's 403 body — the agent reads WHY and can retry with a change.
  const respond = useMutation({
    mutationFn: async (input: { batch: OpenBatch; decision: "approve" | "reject" }) => {
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get("/");
      const verdicts = input.batch.payload.requests.map(
        (): Verdict => (input.decision === "approve" ? "approve" : "reject"),
      );
      if (input.decision === "reject") {
        const reason = await promptForRejectReason(input.batch.payload.requests.length);
        if (reason === null) return; // cancelled — leave the batch held
        await decide({
          stream,
          projectId,
          offset: input.batch.offset,
          payload: input.batch.payload,
          verdicts,
          reason: reason || undefined,
          sign: null,
        });
        return;
      }
      // Always sign: an unsigned decision that a keyed project's egress door
      // ignores would still show as "submitted" (a decision landed) and
      // strand the hold with no visible way to retry. Requiring enrollment
      // first means every approval this app sends is real, whether or not
      // other devices have keys.
      if (!enrolledKey) throw new Error("Enroll this device before approving.");
      await decide({
        stream,
        projectId,
        offset: input.batch.offset,
        payload: input.batch.payload,
        verdicts,
        sign: (message) => signWithApproverKey(projectId, message),
      });
    },
  });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Approvals" }} />
      {key.data?.kind === "unenrolled" ? (
        <Pressable
          accessibilityRole="button"
          style={styles.enrollBanner}
          onPress={() => enroll.mutate()}
          disabled={enroll.isPending}
        >
          <Text style={styles.enrollText}>
            {enroll.isPending ? "Enrolling…" : "Enroll this device to sign approvals"}
          </Text>
        </Pressable>
      ) : key.data?.kind === "revoked" ? (
        <Pressable
          accessibilityRole="button"
          style={styles.enrollBanner}
          onPress={() => enroll.mutate()}
          disabled={enroll.isPending}
        >
          <Text style={styles.enrollText}>
            {enroll.isPending
              ? "Re-enrolling…"
              : "This device's approval key was revoked — tap to re-enroll with a fresh key"}
          </Text>
        </Pressable>
      ) : key.data?.kind === "enrolled" ? (
        <View style={styles.enrolledBanner}>
          <Text style={styles.enrolledText}>
            Signing as {key.data.key.label} · {key.data.key.keyId}
          </Text>
        </View>
      ) : null}
      {enroll.isError ? <Text style={styles.error}>{String(enroll.error.message)}</Text> : null}
      {respond.isError ? <Text style={styles.error}>{String(respond.error.message)}</Text> : null}

      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : events.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{String(events.error.message)}</Text>
          <Pressable onPress={() => events.refetch()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={open}
          keyExtractor={(batch) => `batch:${batch.offset}`}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            <Text style={styles.empty}>No held requests right now — nothing needs you.</Text>
          }
          refreshing={events.isRefetching}
          onRefresh={() => events.refetch()}
          renderItem={({ item }) => (
            <BatchCard
              baseUrl={baseUrl!}
              interaction={{
                kind: "pending",
                canApprove: enrolledKey !== null,
                onRespond: (decision) => respond.mutate({ batch: item, decision }),
                pending: respond.isPending && respond.variables?.batch.offset === item.offset,
                submitted: item.submitted,
              }}
              offset={item.offset}
              payload={item.payload}
              projectId={projectId}
              projectSlug={slug || ""}
              targeted={item.offset === targetOffset}
            />
          )}
          ListFooterComponent={
            recent.length === 0 ? null : (
              <View style={styles.recent}>
                <Text style={styles.recentTitle}>Recent</Text>
                {recent.map((batch) => (
                  <BatchCard
                    baseUrl={baseUrl!}
                    interaction={{ kind: "resolved", resolved: batch }}
                    key={`resolved:${batch.offset}`}
                    offset={batch.offset}
                    payload={batch.payload}
                    projectId={projectId}
                    projectSlug={slug || ""}
                    targeted={batch.offset === targetOffset}
                  />
                ))}
              </View>
            )
          }
        />
      )}
    </View>
  );
}

/**
 * One approval batch, open or resolved. A batch of one renders exactly like
 * the classic single-request card; a burst gets a count + host-breakdown
 * header with Approve all / Reject all right on it (the Face ID sheet is the
 * confirm step) and per-request details behind an expander.
 */
function BatchCard({
  baseUrl,
  interaction,
  offset,
  payload,
  projectId,
  projectSlug,
  targeted,
}: {
  baseUrl: string;
  interaction:
    | {
        kind: "pending";
        canApprove: boolean;
        onRespond(decision: "approve" | "reject"): void;
        pending: boolean;
        submitted: boolean;
      }
    | { kind: "resolved"; resolved: ResolvedBatch };
  offset: number;
  payload: RequestedPayload;
  projectId: string;
  projectSlug: string;
  targeted: boolean;
}) {
  const queryClient = useQueryClient();
  const single = payload.requests.length === 1;
  const detailsKey = ["approval-details", projectId, offset, interaction.kind];
  const initialDetails = {
    expanded: interaction.kind === "pending",
    members: false,
    script: false,
  };
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
    enabled: details.data.script && streamContext?.kind === "script-execution",
    staleTime: Infinity,
  });
  const toggle = (section: "expanded" | "members" | "script") => {
    queryClient.setQueryData(detailsKey, { ...details.data, [section]: !details.data[section] });
  };

  const headline = single
    ? `${payload.requests[0]!.method} ${safeHost(payload.requests[0]!.url)}`
    : `Script run · ${payload.requests.length} requests`;
  const resolved = interaction.kind === "resolved" ? interaction.resolved : null;

  return (
    <View style={[styles.card, targeted && styles.targetedCard]}>
      {targeted ? (
        <Text style={styles.targetedLabel}>Opened from notification · batch #{offset}</Text>
      ) : null}
      {resolved ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: details.data.expanded }}
          onPress={() => toggle("expanded")}
          style={styles.compactSummary}
        >
          <Text numberOfLines={1} style={[styles.method, styles.compactMethod]}>
            {headline}
          </Text>
          <Text
            style={[
              styles.outcomeBadge,
              resolved.decisionSummary === "Approved" ? styles.approvedBadge : styles.rejectedBadge,
            ]}
          >
            {resolved.decisionSummary}
          </Text>
          <Text style={styles.compactChevron}>{details.data.expanded ? "▾" : "▸"}</Text>
        </Pressable>
      ) : (
        <Text style={styles.method}>{headline}</Text>
      )}
      {single ? null : <Text style={styles.groupHosts}>{hostBreakdown(payload.requests)}</Text>}
      {streamContext?.kind === "script-execution" &&
      streamContext.streamPath.startsWith("/agents/") ? (
        <ThreadContextLine
          baseUrl={baseUrl}
          offsetBound={streamContext.scriptRunRequestedEventOffset}
          projectId={projectId}
          projectSlug={projectSlug}
          streamPath={streamContext.streamPath}
        />
      ) : null}
      {resolved?.reason ? (
        <Text style={styles.rejectReason}>Rejected because: {resolved.reason}</Text>
      ) : null}

      {details.data.expanded ? (
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

          {streamContext?.kind === "script-execution" ? (
            <View style={styles.detailSection}>
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
                    <Text style={styles.threadLinkText}>Show thread</Text>
                  </Pressable>
                ) : null}
              </View>
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
            </View>
          ) : streamContext ? (
            <Text style={styles.sourceMeta}>Triggered from {streamContext.scopePath}</Text>
          ) : (
            <Text style={styles.sourceMeta}>Source metadata unavailable for this request.</Text>
          )}

          <View style={styles.policy}>
            <Text style={styles.detailLabel}>Approval policy</Text>
            <Text style={styles.policyDescription}>
              {payload.ruleDescription || payload.ruleKey}
            </Text>
            <Text style={styles.meta}>
              {payload.ruleKey} · expires {new Date(payload.expiresAt).toLocaleTimeString()}
            </Text>
          </View>

          {interaction.kind === "resolved" ? null : interaction.submitted ? (
            <Text style={styles.submitted}>submitted — awaiting the egress door…</Text>
          ) : (
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, styles.reject]}
                disabled={interaction.pending}
                onPress={() => interaction.onRespond("reject")}
              >
                <Text style={styles.rejectText}>{single ? "Reject" : "Reject all"}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[
                  styles.button,
                  styles.approve,
                  !interaction.canApprove && styles.buttonDisabled,
                ]}
                disabled={interaction.pending || !interaction.canApprove}
                onPress={() => interaction.onRespond("approve")}
              >
                <Text style={styles.approveText}>
                  {interaction.pending
                    ? "Signing…"
                    : !interaction.canApprove
                      ? "Enroll to approve"
                      : single
                        ? "Approve (Face ID)"
                        : `Approve all ${payload.requests.length} (Face ID)`}
                </Text>
              </Pressable>
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

/**
 * "What was this run even doing?" — the agent thread's last visible message
 * at the moment the batch was born, pinned to the card so the queue and
 * history read without opening each thread. A snapshot deliberately, not live
 * status: it is derived from immutable history at the script-run offset, so
 * it works identically for open and settled batches. The line renders
 * immediately with the thread name (tap = open the thread) and grows the
 * message once the one-shot fetch lands; a slow or failed fetch never blocks
 * the card.
 */
function ThreadContextLine({
  baseUrl,
  offsetBound,
  projectId,
  projectSlug,
  streamPath,
}: {
  baseUrl: string;
  offsetBound: number;
  projectId: string;
  projectSlug: string;
  streamPath: string;
}) {
  const context = useQuery({
    queryKey: ["approval-thread-context", baseUrl, projectId, streamPath, offsetBound],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get(streamPath);
      // Page the whole bounded window: a busy thread can hold more visible
      // messages than one getEvents page, and only the LAST one matters.
      const events: StreamEvent[] = [];
      let cursor = 0;
      while (true) {
        const page = await stream.getEvents({
          afterOffset: cursor,
          beforeOffset: offsetBound + 1, // exclusive bound — at-or-before the script run
          eventTypes: [USER_MESSAGE_TYPE, ASSISTANT_MESSAGE_TYPE],
        });
        if (page.length === 0) break;
        events.push(...page);
        cursor = page.at(-1)!.offset;
      }
      return lastVisibleMessageAtOrBefore(events, offsetBound);
    },
    staleTime: Infinity,
  });
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
      <Text numberOfLines={1} style={styles.threadContextText}>
        <Text style={styles.threadContextName}>{streamPath.replace(/^\/agents\//, "")}</Text>
        {context.data
          ? ` · ${context.data.role === "user" ? "you" : "agent"}: ${context.data.text}`
          : ""}
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
  screen: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  enrollBanner: {
    backgroundColor: colors.text,
    borderRadius: radius.md,
    margin: spacing.md,
    marginBottom: 0,
    alignItems: "center",
    paddingVertical: 14,
  },
  enrollText: { color: colors.background, fontSize: 15, fontWeight: "600" },
  enrolledBanner: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  enrolledText: { color: colors.textMuted, fontSize: 12, fontFamily: "Menlo" },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  targetedCard: { borderColor: colors.accent, borderWidth: 2 },
  targetedLabel: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  compactSummary: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 30,
  },
  compactMethod: { flex: 1 },
  compactChevron: { color: colors.textFaint, fontSize: 12 },
  outcomeBadge: {
    borderRadius: radius.full,
    borderWidth: 1,
    fontSize: 11,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  approvedBadge: { borderColor: colors.accent, color: colors.accent },
  rejectedBadge: { borderColor: colors.danger, color: colors.danger },
  outcomeDetail: { color: colors.textMuted, fontSize: 11 },
  method: { color: colors.text, fontSize: 15, fontWeight: "600" },
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
  submitted: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
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
  groupHosts: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 11 },
  rejectReason: { color: colors.danger, fontSize: 12 },
  groupMembers: {
    gap: spacing.sm,
  },
  memberCard: {
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  recent: { marginTop: spacing.lg, gap: spacing.sm },
  recentTitle: { color: colors.textFaint, fontSize: 11, textTransform: "uppercase" },
  empty: { color: colors.textMuted, fontSize: 14 },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  retry: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  retryText: { color: colors.text, fontSize: 14 },
});
