// Human-in-the-loop egress approvals for one project. Enroll this device
// (generates a P-256 "software" approval key — same kind
// packages/iterate/src/approval-keys.ts uses for CI/non-Mac machines — and
// keeps the private half in the Keychain behind Face ID / Touch ID), then
// grant or reject held requests as they arrive live. See
// apps/mobile/src/lib/approvals.ts for the protocol and
// tasks/mobile-native-capabilities.md for what a real dev build would add
// (hardware-isolated signing, push notifications).

import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { enrollApproverKey, loadApproverKey, signWithApproverKey } from "../../../lib/approver.ts";
import {
  deriveOpenRequests,
  EVENT,
  grant,
  reject,
  safeHost,
  type OpenRequest,
} from "../../../lib/approvals.ts";
import { approvalsQueryKey, loadAndFollowApprovals } from "../../../lib/live-approvals.ts";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function ApprovalsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

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
      const itx = await getItxSession(baseUrl!);
      const project = await itx.projects.get(projectId);
      const stream = project.streams.get("/");
      await stream.append({
        type: EVENT.keyAdded,
        payload: { keyId: info.keyId, publicKey: info.publicKey, label: info.label },
      });
      return info;
    },
    onSuccess: () => key.refetch(),
  });

  const events = useQuery({
    queryKey: baseUrl ? approvalsQueryKey(baseUrl, projectId) : ["approval-events", "pending"],
    queryFn: async () => {
      try {
        return await loadAndFollowApprovals(baseUrl!, projectId);
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
    enabled: baseUrl !== undefined,
    staleTime: Infinity,
  });

  const open = useMemo(() => deriveOpenRequests(events.data || []), [events.data]);
  const recentOutcomes = useMemo(() => {
    const outcomes = (events.data || []).filter(
      (event) => event.type === EVENT.settled || event.type === EVENT.rejected,
    );
    return outcomes.slice(-5).reverse();
  }, [events.data]);

  const respond = useMutation({
    mutationFn: async (input: { request: OpenRequest; decision: "grant" | "reject" }) => {
      const itx = await getItxSession(baseUrl!);
      const project = await itx.projects.get(projectId);
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
              <View style={styles.card}>
                <Text style={styles.method}>
                  {request.payload.method} {safeHost(request.payload.url)}
                </Text>
                <Text style={styles.url} numberOfLines={2}>
                  {request.payload.url}
                </Text>
                {request.payload.secretPaths.length > 0 ? (
                  <Text style={styles.secretLine}>
                    spends {request.payload.secretPaths.join(", ")}
                  </Text>
                ) : null}
                <Text style={styles.meta}>
                  rule: {request.payload.ruleKey} · expires{" "}
                  {new Date(request.payload.expiresAt).toLocaleTimeString()}
                </Text>
                {request.submitted ? (
                  <Text style={styles.submitted}>submitted — awaiting the egress door…</Text>
                ) : (
                  <View style={styles.actions}>
                    <Pressable
                      style={[styles.button, styles.reject]}
                      disabled={pending}
                      onPress={() => respond.mutate({ request, decision: "reject" })}
                    >
                      <Text style={styles.rejectText}>Reject</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.button, styles.approve, !key.data && styles.buttonDisabled]}
                      disabled={pending || !key.data}
                      onPress={() => respond.mutate({ request, decision: "grant" })}
                    >
                      <Text style={styles.approveText}>
                        {pending
                          ? "Signing…"
                          : key.data
                            ? "Approve (Face ID)"
                            : "Enroll to approve"}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
          ListFooterComponent={
            recentOutcomes.length === 0 ? null : (
              <View style={styles.recent}>
                <Text style={styles.recentTitle}>Recent</Text>
                {recentOutcomes.map((event) => (
                  <Text key={event.offset} style={styles.recentLine}>
                    {event.type === EVENT.settled
                      ? `#${(event.payload as { approvalRequestEventOffset: number }).approvalRequestEventOffset} released — upstream ${(event.payload as { status?: number }).status ?? "?"}`
                      : `#${(event.payload as { approvalRequestEventOffset: number }).approvalRequestEventOffset} rejected`}
                  </Text>
                ))}
              </View>
            )
          }
        />
      )}
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
  method: { color: colors.text, fontSize: 15, fontWeight: "600" },
  url: { color: colors.textMuted, fontSize: 12, fontFamily: "Menlo" },
  secretLine: { color: colors.working, fontSize: 12 },
  meta: { color: colors.textFaint, fontSize: 11 },
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
  recent: { marginTop: spacing.lg, gap: 2 },
  recentTitle: { color: colors.textFaint, fontSize: 11, textTransform: "uppercase" },
  recentLine: { color: colors.textMuted, fontSize: 12 },
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
