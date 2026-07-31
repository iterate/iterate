// A held approval batch rendered INSIDE the chat thread it came from — the
// approval moment happens where the conversation is, not on a separate
// screen. Compact on purpose: hosts, rule, Approve all / Reject all. The
// full inspectable card (bodies, script source, history) stays on the
// Approvals screen, which is now the cross-thread queue + history view.

import { useMutation, useQuery } from "@tanstack/react-query";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { decide, EVENT, hostBreakdown, type OpenBatch, type Verdict } from "../lib/approvals.ts";
import { signWithApproverKey } from "../lib/approver.ts";
import { getProjectItx } from "../lib/itx.ts";
import { promptForRejectReason } from "../lib/reject-reason.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function InThreadApprovalCard({
  baseUrl,
  batch,
  canApprove,
  projectId,
}: {
  baseUrl: string;
  batch: OpenBatch;
  canApprove: boolean;
  projectId: string;
}) {
  // Tell push channels the user is already looking at this batch: a claim
  // that lands inside the device processor's ~1.5s grace window suppresses
  // the pending approval push on EVERY device, and a claim after the push
  // went out is a harmless no-op — so failures are ignored (the push simply
  // goes out, the designed fallback). useQuery fires it once per batch per
  // mount; the idempotency key makes any refire a stream-level no-op. Only a
  // foregrounded app may claim — the queryFn WAITS for the foreground rather
  // than gating on a one-shot `enabled` read, so a card mounted while the
  // app is backgrounded still claims the moment the user comes back (the
  // card is still on screen then — navigation can't happen backgrounded).
  // On web, AppState.currentState is always "active", so the wait is a
  // no-op there.
  useQuery({
    queryKey: ["approval-presented", projectId, batch.offset],
    queryFn: async () => {
      await appForegrounded();
      const project = await getProjectItx(baseUrl, projectId);
      await project.streams.get("/").append({
        type: EVENT.presented,
        idempotencyKey: `project/approval-presented:${batch.offset}`,
        payload: { approvalRequestEventOffset: batch.offset },
      });
      return true;
    },
    staleTime: Infinity,
    retry: false,
  });

  const respond = useMutation({
    mutationFn: async (decision: "approve" | "reject") => {
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get("/");
      const verdicts = batch.payload.requests.map(
        (): Verdict => (decision === "approve" ? "approve" : "reject"),
      );
      if (decision === "reject") {
        const reason = await promptForRejectReason(batch.payload.requests.length);
        if (reason === null) return; // cancelled — leave the batch held
        await decide({
          stream,
          projectId,
          offset: batch.offset,
          payload: batch.payload,
          verdicts,
          reason: reason || undefined,
          sign: null,
        });
        return;
      }
      await decide({
        stream,
        projectId,
        offset: batch.offset,
        payload: batch.payload,
        verdicts,
        sign: (message) => signWithApproverKey(projectId, message),
      });
    },
  });

  const count = batch.payload.requests.length;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        {count === 1
          ? "The agent needs your approval"
          : `The agent needs approval for ${count} requests`}
      </Text>
      <Text style={styles.hosts}>{hostBreakdown(batch.payload.requests)}</Text>
      <Text style={styles.policy}>
        {batch.payload.ruleDescription || batch.payload.ruleKey} · expires{" "}
        {new Date(batch.payload.expiresAt).toLocaleTimeString()}
      </Text>
      {batch.submitted ? (
        <Text style={styles.submitted}>submitted — awaiting the egress door…</Text>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            style={[styles.button, styles.reject]}
            disabled={respond.isPending}
            onPress={() => respond.mutate("reject")}
          >
            <Text style={styles.rejectText}>{count === 1 ? "Reject" : "Reject all"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={[styles.button, styles.approve, !canApprove && styles.buttonDisabled]}
            disabled={respond.isPending || !canApprove}
            onPress={() => respond.mutate("approve")}
          >
            <Text style={styles.approveText}>
              {respond.isPending
                ? "Signing…"
                : !canApprove
                  ? "Enroll to approve"
                  : count === 1
                    ? "Approve (Face ID)"
                    : `Approve all ${count} (Face ID)`}
            </Text>
          </Pressable>
        </View>
      )}
      {respond.isError ? <Text style={styles.error}>{String(respond.error.message)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  title: { color: colors.text, fontSize: 14, fontWeight: "600" },
  hosts: { color: colors.textMuted, fontFamily: "Menlo", fontSize: 11 },
  policy: { color: colors.textMuted, fontSize: 12 },
  submitted: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  button: { flex: 1, borderRadius: radius.sm, paddingVertical: 10, alignItems: "center" },
  reject: { borderColor: colors.danger, borderWidth: 1 },
  rejectText: { color: colors.danger, fontSize: 14, fontWeight: "600" },
  approve: { backgroundColor: colors.accent },
  buttonDisabled: { opacity: 0.4 },
  approveText: { color: colors.background, fontSize: 14, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
});

/**
 * Resolves once the app is foregrounded — immediately when it already is
 * (always, on web). One-shot: the listener removes itself on the first
 * "active" transition, so an abandoned wait leaks nothing beyond a single
 * subscription for the app's backgrounded lifetime.
 */
function appForegrounded(): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      subscription.remove();
      resolve();
    });
  });
}
