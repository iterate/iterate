// Every notification this device was ever asked to show, newest first, with
// where it got to — including "Skipped — already on screen", the
// suppression the in-thread approval claim produces. The list reads THIS
// device's own stream (the device processor journals the whole obligation
// there) and stays live, so a push settling while the screen is open updates
// its row in place.
//
// Approval rows EXPAND in place (collapsed by default) into the full batch
// detail — requests, rule, verdicts, reason, the thread's status at the
// time, the originating script — via the shared ApprovalBatchBody; a
// still-open batch gets the decide actions right in the expansion. This
// screen IS the approvals surface now (the standalone Approvals screen is
// retired): the approver-key banner sits on top, and approvals-destination
// pushes land here with the matching row pre-expanded. The chat deep-link
// lives inside the expansion as its "Open thread" affordance; non-approval
// rows keep tap-to-navigate (lib/notification-routing.ts), exactly like
// tapping the real push.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { StreamEvent } from "iterate/sdk/itx/react";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
  ApprovalBatchActions,
  ApprovalBatchBody,
  ThreadContextLine,
} from "../../../components/approval-batch.tsx";
import { ApproverKeyBanner } from "../../../components/approver-key-banner.tsx";
import {
  APPROVAL_STREAM_EVENT_TYPES,
  deriveBatchDetail,
  EVENT,
  readAllApprovalEvents,
} from "../../../lib/approvals.ts";
import { getMobileDeviceId } from "../../../lib/device-identity.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  deriveDeviceNotifications,
  deriveNotificationListRows,
  DEVICE_NOTIFICATION_EVENT_TYPES,
  type NotificationListRow,
} from "../../../lib/notifications.ts";
import { pushNotificationRoute } from "../../../lib/notification-routing.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

export default function NotificationsScreen() {
  const { projectId, slug, approvalRequestEventOffset } = useLocalSearchParams<{
    projectId: string;
    slug?: string;
    approvalRequestEventOffset?: string;
  }>();
  // An approvals-destination push (scope holds still emit these) lands here
  // with the batch it is about — that row starts expanded. No scroll-to: the
  // list is newest-first, so a fresh push's row is at or near the top.
  const parsedTargetOffset = Number(approvalRequestEventOffset);
  const targetOffset =
    Number.isSafeInteger(parsedTargetOffset) && parsedTargetOffset > 0 ? parsedTargetOffset : null;

  const server = useQuery({
    queryKey: ["server"],
    queryFn: async () => (await getServerBaseUrl()) || DEFAULT_SERVER,
    staleTime: Infinity,
  });
  const baseUrl = server.data;
  const device = useQuery({
    queryKey: ["mobile-device-id"],
    queryFn: () => getMobileDeviceId(),
    staleTime: Infinity,
  });
  const deviceStreamPath = device.data === undefined ? undefined : `/devices/${device.data}`;

  const events = useLiveEvents({
    queryKey: ["device-notification-events", baseUrl || "pending", projectId, deviceStreamPath],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await project.streams
        .get(deviceStreamPath!)
        .getEvents({ eventTypes: DEVICE_NOTIFICATION_EVENT_TYPES });
    },
    enabled: baseUrl !== undefined && deviceStreamPath !== undefined,
    eventTypes: DEVICE_NOTIFICATION_EVENT_TYPES,
    projectId,
    streamPath: deviceStreamPath || "/devices/pending",
  });
  // The device stream alone leaves a hole: an open batch that never
  // journaled here (parked before enrollment, notifications denied, any
  // delivery gap) would have NO decision surface anywhere — so the screen
  // also watches the project root stream's approval events (the chat
  // screen's exact subscription, same query key, shared cache) and unions
  // open batches in as synthetic needs-approval rows.
  const approvalEvents = useLiveEvents({
    queryKey: ["approval-events", baseUrl || "pending", projectId],
    read: async () => {
      const project = await getProjectItx(baseUrl!, projectId);
      return await readAllApprovalEvents(project.streams.get("/"));
    },
    enabled: baseUrl !== undefined,
    eventTypes: APPROVAL_STREAM_EVENT_TYPES,
    projectId,
    streamPath: "/",
  });
  // Batches decided from THIS screen instance. A decided batch normally
  // leaves the synthetic list (all-reject closes it instantly), but it must
  // not vanish under the finger that just decided it — these linger with
  // their outcome for the rest of the session. Genuine ephemeral UI state,
  // same as the row expansion toggle.
  const [sessionDecidedOffsets, setSessionDecidedOffsets] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const rows = deriveNotificationListRows(
    deriveDeviceNotifications(events.data || []),
    approvalEvents.data || [],
    sessionDecidedOffsets,
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} notifications` : "Notifications" }} />
      {baseUrl === undefined ? null : <ApproverKeyBanner baseUrl={baseUrl} projectId={projectId} />}
      {events.isPending || device.isPending || approvalEvents.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
        </View>
      ) : events.isError || approvalEvents.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>
            {String(events.isError ? events.error.message : approvalEvents.error.message)}
          </Text>
          <Pressable
            onPress={() => {
              void events.refetch();
              void approvalEvents.refetch();
            }}
            style={styles.retry}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) =>
            row.kind === "device"
              ? `device-${row.requestOffset}`
              : `batch-${row.approvalRequestEventOffset}`
          }
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No notifications yet. When the project needs you — an approval, a script talking to
              this phone — they land here with what happened to each one.
            </Text>
          }
          refreshing={events.isRefetching || approvalEvents.isRefetching}
          onRefresh={() => {
            void events.refetch();
            void approvalEvents.refetch();
          }}
          renderItem={({ item: row }) => (
            <NotificationRow
              baseUrl={baseUrl!}
              liveApprovalEvents={approvalEvents.data || []}
              onSessionDecided={(offset) =>
                setSessionDecidedOffsets((previous) => new Set(previous).add(offset))
              }
              projectId={projectId}
              projectSlug={slug || ""}
              row={row}
              targeted={
                row.approvalRequestEventOffset !== null &&
                row.approvalRequestEventOffset === targetOffset
              }
            />
          )}
        />
      )}
    </View>
  );
}

/**
 * One list row — a journaled device notification, or a synthetic
 * needs-approval row for an open batch that never journaled on this device.
 * Approval rows of either kind (they carry the batch identity) toggle an
 * inline detail expansion — ActivityCard's useState toggle precedent, the
 * chevron marking the affordance; the deep link lives INSIDE the expansion.
 * Everything else keeps the push's tap-to-navigate behavior.
 */
function NotificationRow({
  baseUrl,
  liveApprovalEvents,
  onSessionDecided,
  projectId,
  projectSlug,
  row,
  targeted,
}: {
  baseUrl: string;
  liveApprovalEvents: StreamEvent[];
  onSessionDecided: (offset: number) => void;
  projectId: string;
  projectSlug: string;
  row: NotificationListRow;
  targeted: boolean;
}) {
  // ActivityCard's toggle pattern: an untouched toggle falls back to the
  // default — expanded when this row is what a push navigated here for.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? targeted;
  const expandable = row.approvalRequestEventOffset !== null;
  const openDestination = () => {
    // Synthetic rows are always expandable, so this only fires for a device
    // row without a batch identity — the push's own tap behavior.
    if (row.kind !== "device") return;
    const route = pushNotificationRoute({
      destination: row.destination || undefined,
      projectId,
      requestOffset: row.requestOffset,
    });
    if (route !== null) router.push(route);
  };
  return (
    <View
      style={styles.row}
      testID={
        row.kind === "device"
          ? `notification-row-${row.requestOffset}`
          : `needs-approval-row-${row.approvalRequestEventOffset}`
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded } : undefined}
        onPress={() => (expandable ? setToggled(!expanded) : openDestination())}
      >
        <View style={styles.rowHeader}>
          {expandable ? <Text style={styles.chevron}>{expanded ? "▾" : "▸"}</Text> : null}
          <Text numberOfLines={1} style={styles.title}>
            {row.title}
          </Text>
          <Text style={styles.date}>{formatRequestedAt(row.requestedAt)}</Text>
        </View>
        {row.body === "" ? null : (
          <Text numberOfLines={2} style={styles.body}>
            {row.body}
          </Text>
        )}
        <Text
          style={[
            styles.status,
            row.status.kind === "suppressed" && styles.suppressed,
            row.status.kind === "needs-approval" && styles.needsApproval,
          ]}
        >
          {row.status.label}
        </Text>
      </Pressable>
      {expanded && row.approvalRequestEventOffset !== null ? (
        <ApprovalNotificationDetail
          baseUrl={baseUrl}
          batchOffset={row.approvalRequestEventOffset}
          liveApprovalEvents={liveApprovalEvents}
          onSessionDecided={onSessionDecided}
          projectId={projectId}
          projectSlug={projectSlug}
        />
      ) : null}
    </View>
  );
}

/**
 * The expanded approval detail under a notification row: the batch's events
 * fetched one-shot from the project root stream by offset, rendered with the
 * SAME shared pieces the Approvals screen's history cards use. Decided-and-
 * settled history is immutable and caches forever; an undecided batch stays
 * provisional and refetches — the same settledness gating as the
 * thread-context line.
 */
function ApprovalNotificationDetail({
  baseUrl,
  batchOffset,
  liveApprovalEvents,
  onSessionDecided,
  projectId,
  projectSlug,
}: {
  baseUrl: string;
  batchOffset: number;
  liveApprovalEvents: StreamEvent[];
  onSessionDecided: (offset: number) => void;
  projectId: string;
  projectSlug: string;
}) {
  const queryClient = useQueryClient();
  const batch = useQuery({
    queryKey: ["notification-approval-batch", baseUrl, projectId, batchOffset],
    queryFn: async () => {
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get("/");
      // Page from just below the batch's own offset: its decided/settled
      // events can only come after it. Approval events are sparse and
      // SQL-filtered before the page limit, so the loop is only for the
      // pathological many-batches-later case.
      const events: StreamEvent[] = [];
      let cursor = batchOffset - 1;
      let detail = null;
      while (true) {
        const page = await stream.getEvents({
          afterOffset: cursor,
          eventTypes: [EVENT.requested, EVENT.decided, EVENT.settled],
        });
        if (page.length === 0) break;
        events.push(...page);
        cursor = page.at(-1)!.offset;
        // Completed history is immutable — stop paging the moment the batch
        // is fully accounted for instead of scanning to the stream head.
        detail = deriveBatchDetail(events, batchOffset);
        if (detail?.complete) break;
      }
      return detail;
    },
    staleTime: (query) => (query.state.data?.complete ? Infinity : 5_000),
    refetchInterval: (query) => (query.state.data?.complete ? false : 5_000),
  });

  // Live first: open and orphan rows were DERIVED from the live approval
  // subscription, so their payload is already in memory — a pending, failed,
  // or empty one-shot fetch must not block the body or the decide actions.
  // A live resolution also wins over fetched data (retires actions
  // immediately; the 5s provisional poll covers backlog gaps, not races).
  // The fetch remains authoritative only for deep-history batches outside
  // the live window.
  const liveDetail = deriveBatchDetail(liveApprovalEvents, batchOffset);
  const detail = (liveDetail?.resolved ? liveDetail : null) || batch.data || liveDetail;
  if (detail === null || detail === undefined) {
    if (batch.isPending) {
      return (
        <View style={styles.detail}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} size="small" />
        </View>
      );
    }
    if (batch.isError) {
      return (
        <View style={styles.detail}>
          <Text style={styles.detailError}>{String(batch.error.message)}</Text>
        </View>
      );
    }
    return (
      <View style={styles.detail}>
        <Text style={styles.detailMuted}>This batch's history isn't on the stream anymore.</Text>
      </View>
    );
  }
  const { payload, resolved } = detail;
  const streamContext = payload.streamContext;
  const expired = Date.parse(payload.expiresAt) <= Date.now();
  return (
    <View style={styles.detail}>
      <View style={styles.decisionRow}>
        {resolved ? (
          <Text
            style={[
              styles.outcomeBadge,
              resolved.decisionSummary === "Approved" ? styles.approvedBadge : styles.rejectedBadge,
            ]}
            testID="approval-decision-badge"
          >
            {resolved.decisionSummary}
          </Text>
        ) : expired ? (
          // The door's expiry decision usually lands moments later and flips
          // this to a real Expired resolution — but never advertise a hold
          // nobody can answer in the interim.
          <Text style={styles.detailMuted}>Expired</Text>
        ) : (
          <Text style={styles.detailMuted}>Awaiting decision</Text>
        )}
      </View>
      {resolved?.reason ? (
        <Text style={styles.rejectReason}>Rejected because: {resolved.reason}</Text>
      ) : null}
      {streamContext?.kind === "script-execution" &&
      streamContext.streamPath.startsWith("/agents/") ? (
        <ThreadContextLine
          baseUrl={baseUrl}
          executionId={streamContext.executionId}
          projectId={projectId}
          projectSlug={projectSlug}
          streamPath={streamContext.streamPath}
        />
      ) : null}
      <ApprovalBatchBody
        baseUrl={baseUrl}
        offset={batchOffset}
        payload={payload}
        projectId={projectId}
        projectSlug={projectSlug}
        resolved={resolved}
        showScriptSource={true}
        showThreadInfo={true}
        surface="notification"
      />
      {resolved === null && !expired ? (
        // A still-open batch is decidable right here — this screen is the
        // approvals surface now. An expired-undecided one shows nothing
        // extra: the door's expiry decision lands within the provisional
        // refetch window and flips the badge to Expired.
        <ApprovalBatchActions
          baseUrl={baseUrl}
          offset={batchOffset}
          onDecided={() => {
            // Keeps this batch's row visible (with its outcome) for the rest
            // of the session — the row must not vanish under the finger that
            // just decided it.
            onSessionDecided(batchOffset);
            void queryClient.invalidateQueries({
              queryKey: ["notification-approval-batch", baseUrl, projectId, batchOffset],
            });
            // Synthetic-row MEMBERSHIP derives from the live approval cache —
            // refetch it too, so a decided orphan row flips to its outcome
            // (or awaiting-release) without waiting on the websocket
            // catch-up.
            void queryClient.invalidateQueries({
              queryKey: ["approval-events", baseUrl, projectId],
            });
          }}
          payload={payload}
          projectId={projectId}
        />
      ) : null}
    </View>
  );
}

/** Same-day rows show the time; older ones the date — enough for a flat list. */
function formatRequestedAt(iso: string) {
  const at = new Date(iso);
  const now = new Date();
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString()
    : at.toLocaleDateString();
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
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  rowHeader: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  chevron: { color: colors.textFaint, fontSize: 12, width: 12 },
  title: { color: colors.text, flex: 1, fontSize: 14, fontWeight: "600" },
  date: { color: colors.textFaint, fontSize: 12 },
  detail: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  decisionRow: { flexDirection: "row" },
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
  rejectReason: { color: colors.danger, fontSize: 12 },
  detailMuted: { color: colors.textMuted, fontSize: 12 },
  detailError: { color: colors.danger, fontSize: 12 },
  body: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  status: { color: colors.textMuted, fontSize: 12, fontStyle: "italic" },
  suppressed: { color: colors.accent },
  needsApproval: { color: colors.working },
  empty: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
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
