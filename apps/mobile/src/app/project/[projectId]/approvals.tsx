// Human-in-the-loop egress approvals for one project. Enroll this device
// (generates a P-256 "software" approval key — same kind
// packages/iterate/src/approval-keys.ts uses for CI/non-Mac machines — and
// keeps the private half in the Keychain behind Face ID / Touch ID), then
// grant or reject held requests as they arrive live. See
// apps/mobile/src/lib/approvals.ts for the protocol and
// tasks/mobile-native-capabilities.md for what a real dev build would add
// (hardware-isolated signing, push notifications).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
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
import { enrollApproverKey, loadApproverKey, signWithApproverKey } from "../../../lib/approver.ts";
import {
  approvalBodyHash,
  deriveOpenRequests,
  deriveRecentResolvedRequests,
  EVENT,
  focusOpenRequest,
  approvalBodyForDisplay,
  grant,
  reject,
  safeHost,
  scriptCodeForApproval,
  type OpenRequest,
  type RequestedPayload,
  type ResolvedRequest,
} from "../../../lib/approvals.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

const APPROVAL_EVENT_TYPES = [EVENT.requested, EVENT.granted, EVENT.rejected, EVENT.settled];

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

  const key = useQuery({
    queryKey: ["approver-key", projectId],
    queryFn: () => loadApproverKey(projectId),
  });

  const enroll = useMutation({
    mutationFn: async () => {
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
    () => focusOpenRequest(deriveOpenRequests(events.data || []), targetOffset),
    [events.data, targetOffset],
  );
  const recentResolved = useMemo(
    () => deriveRecentResolvedRequests(events.data || [], 5),
    [events.data],
  );

  const respond = useMutation({
    mutationFn: async (input: { request: OpenRequest; decision: "grant" | "reject" }) => {
      const project = await getProjectItx(baseUrl!, projectId);
      const stream = project.streams.get("/");
      if (input.decision === "reject") {
        await reject(stream, input.request.offset);
        return;
      }
      // Always sign: an unsigned grant that a keyed project's egress door
      // ignores would still show as "submitted" (a grant landed) and strand
      // the hold with no visible way to retry. Requiring enrollment first
      // means every grant this app sends is real, whether or not other
      // devices have keys.
      if (!key.data) throw new Error("Enroll this device before approving.");
      await grant({
        stream,
        projectId,
        offset: input.request.offset,
        payload: input.request.payload,
        sign: (message) => signWithApproverKey(projectId, message),
      });
    },
  });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Approvals" }} />
      {key.data === null ? (
        <Pressable
          style={styles.enrollBanner}
          onPress={() => enroll.mutate()}
          disabled={enroll.isPending}
        >
          <Text style={styles.enrollText}>
            {enroll.isPending ? "Enrolling…" : "Enroll this device to sign approvals"}
          </Text>
        </Pressable>
      ) : key.data ? (
        <View style={styles.enrolledBanner}>
          <Text style={styles.enrolledText}>
            Signing as {key.data.label} · {key.data.keyId}
          </Text>
        </View>
      ) : null}
      {enroll.isError ? <Text style={styles.error}>{String(enroll.error.message)}</Text> : null}
      {respond.isError ? <Text style={styles.error}>{String(respond.error.message)}</Text> : null}

      {events.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
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
          keyExtractor={(request) => String(request.offset)}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            <Text style={styles.empty}>No held requests right now — nothing needs you.</Text>
          }
          refreshing={events.isRefetching}
          onRefresh={() => events.refetch()}
          renderItem={({ item: request }) => {
            const pending =
              respond.isPending && respond.variables?.request.offset === request.offset;
            return (
              <ApprovalCard
                baseUrl={baseUrl!}
                interaction={{
                  kind: "pending",
                  canApprove: Boolean(key.data),
                  onRespond: (decision) => respond.mutate({ request, decision }),
                  pending,
                  submitted: request.submitted,
                }}
                projectId={projectId}
                projectSlug={slug || ""}
                request={request}
                targeted={request.offset === targetOffset}
              />
            );
          }}
          ListFooterComponent={
            recentResolved.length === 0 ? null : (
              <View style={styles.recent}>
                <Text style={styles.recentTitle}>Recent</Text>
                {recentResolved.map((request) => (
                  <ApprovalCard
                    baseUrl={baseUrl!}
                    interaction={{ kind: "resolved", outcome: request.outcome }}
                    key={request.offset}
                    projectId={projectId}
                    projectSlug={slug || ""}
                    request={request}
                    targeted={request.offset === targetOffset}
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

function ApprovalCard({
  baseUrl,
  interaction,
  projectId,
  projectSlug,
  request,
  targeted,
}: {
  baseUrl: string;
  interaction:
    | {
        kind: "pending";
        canApprove: boolean;
        onRespond(decision: "grant" | "reject"): void;
        pending: boolean;
        submitted: boolean;
      }
    | { kind: "resolved"; outcome: ResolvedRequest["outcome"] };
  projectId: string;
  projectSlug: string;
  request: { offset: number; payload: RequestedPayload };
  targeted: boolean;
}) {
  const queryClient = useQueryClient();
  const detailsKey = ["approval-details", projectId, request.offset, interaction.kind];
  const initialDetails = {
    body: false,
    expanded: interaction.kind === "pending",
    script: false,
  };
  const details = useQuery({
    queryKey: detailsKey,
    queryFn: async () => initialDetails,
    initialData: initialDetails,
    staleTime: Infinity,
  });
  const streamContext = request.payload.streamContext;
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
        : ["approval-source-script", baseUrl, projectId, "none", request.offset],
    queryFn: async () => {
      if (streamContext?.kind !== "script-execution") {
        throw new Error("This approval has no codemode script source.");
      }
      const project = await getProjectItx(baseUrl, projectId);
      const event = await project.streams.get(streamContext.streamPath).getEvent({
        offset: streamContext.scriptRunRequestedEventOffset,
      });
      return scriptCodeForApproval(request.payload, event);
    },
    enabled: details.data.script && streamContext?.kind === "script-execution",
    staleTime: Infinity,
  });
  const body = approvalBodyForDisplay(request.payload);
  const toggle = (section: "body" | "expanded" | "script") => {
    queryClient.setQueryData(detailsKey, { ...details.data, [section]: !details.data[section] });
  };

  return (
    <View style={[styles.card, targeted && styles.targetedCard]}>
      {targeted ? (
        <Text style={styles.targetedLabel}>
          Opened from notification · request #{request.offset}
        </Text>
      ) : null}
      {interaction.kind === "resolved" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: details.data.expanded }}
          onPress={() => toggle("expanded")}
          style={styles.compactSummary}
        >
          <Text numberOfLines={1} style={[styles.method, styles.compactMethod]}>
            {request.payload.method} {safeHost(request.payload.url)}
          </Text>
          <Text
            style={[
              styles.outcomeBadge,
              interaction.outcome.decision === "approved"
                ? styles.approvedBadge
                : styles.rejectedBadge,
            ]}
          >
            {interaction.outcome.decision === "approved" ? "Approved" : "Rejected"}
          </Text>
          <Text style={styles.compactChevron}>{details.data.expanded ? "▾" : "▸"}</Text>
        </Pressable>
      ) : (
        <Text style={styles.method}>
          {request.payload.method} {safeHost(request.payload.url)}
        </Text>
      )}

      {details.data.expanded ? (
        <>
          {interaction.kind === "resolved" ? (
            <Text style={styles.outcomeDetail}>
              {interaction.outcome.decision === "rejected"
                ? interaction.outcome.reason
                : interaction.outcome.deliveryError
                  ? `Delivery failed · ${interaction.outcome.deliveryError}`
                  : `Upstream ${interaction.outcome.upstreamStatus || "status unavailable"}`}
            </Text>
          ) : null}
          <Text style={styles.url} selectable>
            {request.payload.url}
          </Text>
          {request.payload.secretPaths.length > 0 ? (
            <Text style={styles.secretLine}>spends {request.payload.secretPaths.join(", ")}</Text>
          ) : null}
          <Text style={styles.meta} selectable>
            body sha256: {approvalBodyHash(request.payload) || "none"}
          </Text>

          {body ? (
            <View style={styles.detailSection}>
              <Pressable
                accessibilityRole="button"
                onPress={() => toggle("body")}
                style={styles.detailHeader}
              >
                <Text style={styles.chevron}>{details.data.body ? "▾" : "▸"}</Text>
                <Text style={styles.detailTitle}>
                  {body.truncated ? "Request body prefix" : "Request body"}
                </Text>
                {request.payload.body?.encoding === "base64" || body.truncated ? (
                  <Text style={styles.detailHint}>
                    {[
                      request.payload.body?.encoding === "base64" ? "base64" : "",
                      body.truncated
                        ? `64 KiB cap · ${body.originalByteLength?.toLocaleString() || "unknown"} bytes total`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                ) : null}
              </Pressable>
              {details.data.body ? (
                body.language === "json" ? (
                  <CodeBlock language="json" muted={false} text={body.text} />
                ) : (
                  <ScrollView style={styles.bodyScroller} nestedScrollEnabled>
                    <Text style={styles.bodyText} selectable>
                      {body.text}
                    </Text>
                  </ScrollView>
                )
              ) : null}
            </View>
          ) : null}

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
                  <ActivityIndicator color={colors.textMuted} size="small" />
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
            <Text style={styles.sourceMeta}>
              Source metadata unavailable for this older request.
            </Text>
          )}

          <View style={styles.policy}>
            <Text style={styles.detailLabel}>Approval policy</Text>
            <Text style={styles.policyDescription}>
              {request.payload.ruleDescription || request.payload.ruleKey}
            </Text>
            <Text style={styles.meta}>
              {request.payload.ruleKey} · expires{" "}
              {new Date(request.payload.expiresAt).toLocaleTimeString()}
            </Text>
          </View>

          {interaction.kind === "resolved" ? null : interaction.submitted ? (
            <Text style={styles.submitted}>submitted — awaiting the egress door…</Text>
          ) : (
            <View style={styles.actions}>
              <Pressable
                style={[styles.button, styles.reject]}
                disabled={interaction.pending}
                onPress={() => interaction.onRespond("reject")}
              >
                <Text style={styles.rejectText}>Reject</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.button,
                  styles.approve,
                  !interaction.canApprove && styles.buttonDisabled,
                ]}
                disabled={interaction.pending || !interaction.canApprove}
                onPress={() => interaction.onRespond("grant")}
              >
                <Text style={styles.approveText}>
                  {interaction.pending
                    ? "Signing…"
                    : interaction.canApprove
                      ? "Approve (Face ID)"
                      : "Enroll to approve"}
                </Text>
              </Pressable>
            </View>
          )}
        </>
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
  outcomeDetail: { color: colors.textMuted, flex: 1, fontSize: 11 },
  method: { color: colors.text, fontSize: 15, fontWeight: "600" },
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
