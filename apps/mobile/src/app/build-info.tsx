// What am I running? Branch/commit/author of the JS bundle (stamped into
// build-info.json at publish time), the EAS Update state (channel, runtime
// fingerprint, embedded vs OTA), and native install facts — plus a button to
// pull the latest update immediately instead of waiting for next launch.
// Exists because dev and preview builds overwrite each other on the phone by
// design, so "which one is this?" needs a first-class answer.

import { useMutation, useQuery } from "@tanstack/react-query";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Stack, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { buildInfo } from "../lib/build-info.ts";
import {
  fetchLatestUpdateAndReload,
  getPreviewChannelOverride,
  switchChannelAndReload,
} from "../lib/preview-channel.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function BuildInfoScreen() {
  const router = useRouter();
  const installedAt = useQuery({
    queryKey: ["app-install-time"],
    // Unavailable on web; the row shows "—" there.
    queryFn: () => Application.getInstallationTimeAsync().catch(() => null),
    staleTime: Infinity,
  });
  const channelOverride = useQuery({
    queryKey: ["preview-channel-override"],
    queryFn: getPreviewChannelOverride,
  });
  const resetChannel = useMutation({
    mutationFn: async () => {
      const result = await switchChannelAndReload(null);
      await channelOverride.refetch();
      return result === "no-update"
        ? "Override cleared — no newer update on the default channel"
        : "Restarting…";
    },
  });
  const check = useMutation({
    mutationFn: async () => {
      const result = await fetchLatestUpdateAndReload();
      return result === "up-to-date" ? "Already up to date" : "Restarting…";
    },
  });

  const bundleSource = !Updates.isEnabled
    ? "Metro dev server"
    : Updates.isEmbeddedLaunch
      ? "embedded in the binary"
      : "OTA update";

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Build info" }} />
      <Section title="Bundle">
        <Row label="Branch" value={buildInfo.branch} />
        <Row label="Commit" value={buildInfo.commit.slice(0, 7)} />
        <Row label="Message" value={buildInfo.message} />
        <Row
          label="Built by"
          value={buildInfo.builtBy && `${buildInfo.builtBy}@${buildInfo.machine}`}
        />
        <Row label="Bundled at" value={formatTime(buildInfo.builtAt)} />
        <Row label="Source" value={bundleSource} />
        {/* What this bundle was published to talk to (empty on main/local
            bundles) — the first thing to check when a preview looks wrong. */}
        <Row label="Expected backend" value={buildInfo.expectedBackendEnv} />
        <Row label="Test login" value={buildInfo.testLoginEmail} />
      </Section>
      <Section title="Updates">
        <Row label="Channel" value={Updates.channel} />
        <Row label="Channel override" value={channelOverride.data} />
        <Row label="Runtime version" value={Updates.runtimeVersion} />
        <Row label="Update id" value={Updates.updateId} />
        <Row label="Update published" value={formatTime(Updates.createdAt?.toISOString())} />
      </Section>
      {/* Both update actions live together, right under the Updates card. */}
      {Updates.isEnabled ? (
        <Pressable
          accessibilityRole="button"
          disabled={check.isPending}
          onPress={() => check.mutate()}
          style={[styles.button, check.isPending && styles.buttonDisabled]}
        >
          <Text style={styles.buttonLabel}>
            {check.isPending ? "Checking…" : "Check for update"}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.note}>
          OTA updates are off in this bundle — it came from a Metro dev server.
        </Text>
      )}
      {check.data ? <Text style={styles.note}>{check.data}</Text> : null}
      {check.error ? <Text style={styles.errorNote}>{String(check.error)}</Text> : null}
      {channelOverride.data ? (
        <Pressable
          accessibilityRole="button"
          disabled={resetChannel.isPending}
          onPress={() => resetChannel.mutate()}
          style={[styles.button, resetChannel.isPending && styles.buttonDisabled]}
        >
          <Text style={styles.buttonLabel}>
            {resetChannel.isPending ? "Resetting…" : "Reset to default channel"}
          </Text>
        </Pressable>
      ) : null}
      {resetChannel.data ? <Text style={styles.note}>{resetChannel.data}</Text> : null}
      {resetChannel.error ? (
        <Text style={styles.errorNote}>{String(resetChannel.error)}</Text>
      ) : null}
      <Section title="App">
        <Row label="Version" value={Constants.expoConfig?.version} />
        <Row label="Native build" value={Application.nativeBuildVersion} />
        <Row label="Installed" value={formatTime(installedAt.data?.toISOString())} />
      </Section>
      {!router.canGoBack() ? (
        // Deep-link flows (preview-channel switch) replace into this screen
        // with no back stack, so the header has no back button.
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace("/")}
          style={styles.linkButton}
        >
          <Text style={styles.linkLabel}>Go home</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function formatTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable style={styles.rowValue}>
        {value || "—"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg, padding: spacing.lg },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: spacing.md,
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  rowLabel: { color: colors.textMuted, fontSize: 14 },
  rowValue: {
    color: colors.text,
    flexShrink: 1,
    fontSize: 14,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  button: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  linkButton: { alignItems: "center", paddingVertical: 8 },
  linkLabel: { color: colors.textMuted, fontSize: 14 },
  note: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  errorNote: { color: colors.danger, fontSize: 13, textAlign: "center" },
});
