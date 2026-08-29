// What am I running? Which channel the JS comes from, which channel this
// binary was built for, the branch/commit/message of the running bundle, and
// whether the channel has anything newer. Exists because dev and preview
// builds overwrite each other on the phone by design, so "which one is this?"
// needs a first-class answer.
//
// A dumb view: every fact and every action comes from lib/build-state.ts.

import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  buildStamp,
  isOverridden,
  MAIN_CHANNEL,
  updateHeadline,
  useBuildActions,
  useBuildState,
} from "../lib/build-state.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function BuildInfoScreen() {
  const router = useRouter();
  // Set by the root layout when it opens this screen on the first boot of a
  // freshly installed binary that had a channel override left over.
  const { clearedOverride } = useLocalSearchParams<{ clearedOverride?: string }>();
  const state = useBuildState();
  const actions = useBuildActions();
  const overridden = isOverridden(state);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Build info" }} />
      {clearedOverride ? (
        <View style={styles.calloutCard}>
          <Text style={styles.calloutTitle}>New build installed</Text>
          <Text style={styles.calloutBody}>
            This phone had been fetching its JS from "{clearedOverride}". That's from before the
            install, so it's been un-set. From now on JS comes from this build's own branch — see
            Channel below.
          </Text>
        </View>
      ) : null}
      {/* Channel first: it is the answer to "am I on the right thing?", and
          the two rows together say whether you got here by scanning a QR or
          by installing this build. */}
      <Section title="Channel">
        <Row
          label="Current"
          value={state.channel}
          note={overridden ? "switched by a QR scan" : undefined}
        />
        <Row
          label="Default for this build"
          value={state.binary.defaultChannel}
          note={overridden ? undefined : "this build's own channel"}
        />
      </Section>
      <Section title="Running JS">
        <Row label="Branch" value={state.running.branch} />
        <Row label="Commit" value={state.running.commit.slice(0, 7)} />
        <Row label="Message" value={state.running.message} />
        <Row
          label="Built by"
          value={state.running.builtBy && `${state.running.builtBy}@${state.running.machine}`}
        />
        <Row label="Published" value={formatTime(state.running.publishedAt)} />
        <Row label="Source" value={sourceLabel[state.running.source]} />
        <Row label="Update id" value={state.updateId} />
        {/* What this bundle was published to talk to (empty on main/local
            bundles) — the first thing to check when a preview looks wrong. */}
        <Row label="Expected backend" value={buildStamp.expectedBackendEnv} />
        <Row label="Test login" value={buildStamp.testLoginEmail} />
      </Section>
      <Section title="Update">
        <Row label="Status" value={updateHeadline(state.update)} />
        {state.update.kind === "behind" ? (
          <>
            <Row label="Latest commit" value={state.update.commit.slice(0, 7)} />
            <Row label="Published" value={formatTime(state.update.publishedAt)} />
          </>
        ) : null}
      </Section>
      {state.update.kind === "unsupported" ? null : (
        <Button
          label={state.update.kind === "behind" ? "Update now" : "Check for update"}
          pending={actions.updateNowPending || state.update.kind === "checking"}
          pendingLabel={state.update.kind === "behind" ? "Updating…" : "Checking…"}
          onPress={() =>
            state.update.kind === "behind"
              ? void actions.updateNow().catch(() => {})
              : void actions.checkNow().catch(() => {})
          }
        />
      )}
      {overridden ? (
        <Button
          label={`Reset to ${state.binary.defaultChannel || "this build's own channel"}`}
          pending={actions.switchChannelPending}
          pendingLabel="Resetting…"
          onPress={() =>
            actions.switchChannel({ channel: null, revertOnNoUpdate: false }).catch(() => {})
          }
        />
      ) : null}
      {/* A per-PR binary's OWN channel is its PR — and once that PR merges,
          cleanup deletes the channel. "Reset to default" can't get such a
          phone back to main; this explicit override to the main channel can.
          Hidden on main binaries, where reset-to-default IS main. Reverts on
          no-update: before its PR merges, a PR binary's native code is newer
          than main's, main serves nothing it can run, and a stuck override
          would make the next restart fall back to the embedded (older) JS. */}
      {state.update.kind !== "unsupported" &&
      state.binary.defaultChannel !== MAIN_CHANNEL &&
      state.channel !== MAIN_CHANNEL ? (
        <Button
          label={`Switch to main (${MAIN_CHANNEL})`}
          pending={actions.switchChannelPending}
          pendingLabel="Switching…"
          onPress={() =>
            actions.switchChannel({ channel: MAIN_CHANNEL, revertOnNoUpdate: true }).catch(() => {})
          }
        />
      ) : null}
      {/* Outcomes are cards, not fine print: a tap whose only feedback is
          small grey text reads as "nothing happened" (it did, in the field). */}
      {actions.switchChannelResult === "no-update" ? (
        actions.switchChannelInput?.channel === MAIN_CHANNEL ? (
          <View style={styles.calloutCard}>
            <Text style={styles.calloutTitle}>Can't switch to main from this build</Text>
            <Text style={styles.calloutBody}>
              This build contains native code main doesn't have yet, so main has no JS it can run.
              Nothing was changed — still on {state.channel || "this build's branch"}. Once the PR
              merges, main catches up and this switch works. To run main today, install a main
              build.
            </Text>
          </View>
        ) : (
          <View style={styles.calloutCard}>
            <Text style={styles.calloutTitle}>Switched — nothing new to download</Text>
            <Text style={styles.calloutBody}>
              Now following {state.channel || "this build's own branch"}, and already running the
              freshest JS it has for this build. No restart needed.
            </Text>
          </View>
        )
      ) : null}
      {actions.switchChannelError ? (
        <Text style={styles.errorNote}>{actions.switchChannelError}</Text>
      ) : null}
      {actions.updateNowError ? (
        <Text style={styles.errorNote}>{actions.updateNowError}</Text>
      ) : null}
      <Section title="App">
        <Row label="Version" value={state.binary.version} />
        <Row label="Native build" value={state.binary.buildNumber} />
        <Row label="Runtime" value={state.binary.runtimeVersion} />
        <Row label="Installed" value={formatTime(state.binary.installedAt)} />
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

const sourceLabel = {
  metro: "Metro dev server",
  embedded: "embedded in the binary",
  ota: "OTA update",
} as const;

function formatTime(iso: string | null | undefined) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function Button(props: {
  label: string;
  pendingLabel: string;
  pending: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.pending}
      onPress={props.onPress}
      style={[styles.button, props.pending && styles.buttonDisabled]}
    >
      <Text style={styles.buttonLabel}>{props.pending ? props.pendingLabel : props.label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null | undefined;
  note?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLabelColumn}>
        <Text style={styles.rowLabel}>{label}</Text>
        {note ? <Text style={styles.rowNote}>{note}</Text> : null}
      </View>
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
  rowLabelColumn: { flexShrink: 0 },
  rowLabel: { color: colors.textMuted, fontSize: 14 },
  rowNote: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
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
  calloutCard: {
    backgroundColor: colors.surface,
    borderColor: colors.textFaint,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 4,
    padding: spacing.md,
  },
  calloutTitle: { color: colors.text, fontSize: 14, fontWeight: "600" },
  calloutBody: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
});
