// This device's approval-key state, as a banner: enroll (generates a P-256
// "software" approval key — same kind packages/iterate/src/approval-keys.ts
// uses for CI/non-Mac machines — and keeps the private half in the Keychain
// behind Face ID / Touch ID), re-enroll after a revocation, or show who the
// device signs as. Moved verbatim from the retired Approvals screen; the
// Notifications screen mounts it above the list, since that is where open
// batches are decided now. The JOIN of the local key and the project's
// enrolled-key state matters: a locally present key the project has revoked
// must NOT offer Approve (the door ignores its signatures — batches would
// strand as "submitted").

import { useMutation, useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { EVENT } from "../lib/approvals.ts";
import { approverKeyStatus, enrollApproverKey, reenrollApproverKey } from "../lib/approver.ts";
import { getProjectItx } from "../lib/itx.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function ApproverKeyBanner({ baseUrl, projectId }: { baseUrl: string; projectId: string }) {
  const key = useQuery({
    queryKey: ["approver-key-status", projectId, baseUrl],
    queryFn: () => approverKeyStatus(baseUrl, projectId),
  });

  const enroll = useMutation({
    mutationFn: async () => {
      if (key.data?.kind === "revoked") {
        // Recovering a revoked device is a deliberate act: fresh keypair,
        // never a resurrection of the revoked keyId.
        return await reenrollApproverKey(baseUrl, projectId, "This iPhone");
      }
      const info = await enrollApproverKey(projectId, "This iPhone");
      const project = await getProjectItx(baseUrl, projectId);
      const stream = project.streams.get("/");
      await stream.append({
        type: EVENT.keyAdded,
        payload: { keyId: info.keyId, publicKey: info.publicKey, label: info.label },
      });
      return info;
    },
    onSuccess: () => key.refetch(),
  });

  return (
    <>
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
    </>
  );
}

const styles = StyleSheet.create({
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
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
});
