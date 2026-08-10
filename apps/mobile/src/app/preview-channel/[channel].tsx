// Deep-link target for PR preview QRs:
//   iterate://preview-channel/<channel>[?env=<envs.ts key>&email=<*+test@nustom.com>]
// `env` is the PR's leased preview slot — the backend this channel's JS
// expects — and `email` a per-PR test identity (CI bakes both in,
// scripts/ci/publish-mobile-pr-preview.ts). This screen owns ONE decision —
// the channel switch (deliberately a confirm, not an auto-switch: a stray
// link tap shouldn't silently repoint the app at another PR's JS). The env
// and email ride along as HINTS: once the channel matches, this screen
// forwards them to the sign-in screen, which suggests the backend and test
// identity there. `env` resolves against the preset list only
// (serverPresetForEnvKey), so a crafted link can't name an arbitrary server.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Updates from "expo-updates";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { buildInfo } from "../../lib/build-info.ts";
import { testEmailFromHint } from "../../lib/deep-link-hints.ts";
import { getPreviewChannelOverride, switchChannelAndReload } from "../../lib/preview-channel.ts";
import { serverPresetForEnvKey } from "../../lib/servers.ts";
import { colors, radius, spacing } from "../../lib/theme.ts";

export default function PreviewChannelScreen() {
  const params = useLocalSearchParams<{ channel: string; env?: string; email?: string }>();
  const { channel } = params;
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: ["preview-channel-override"],
    queryFn: getPreviewChannelOverride,
  });

  const recommendedServer =
    typeof params.env === "string" ? serverPresetForEnvKey(params.env) : null;
  // The test-identity hint ferries onward for per-PR test addresses only;
  // anything else in the param is dropped rather than suggested.
  const testEmail = testEmailFromHint(params.email);
  // What the sign-in screen receives once the channel matches. Hints only —
  // nothing here changes state; the sign-in screen suggests, the user decides.
  const hintParams = {
    ...(recommendedServer !== null && typeof params.env === "string" ? { env: params.env } : {}),
    ...(testEmail !== null ? { email: testEmail } : {}),
  };

  const switchChannel = useMutation({
    mutationFn: () => switchChannelAndReload(channel),
    // Only reaches onSuccess without a reload ("no-update"); the invalidate
    // flips `current` and the button below becomes "Continue". After a real
    // reload the deep link re-opens this screen in the NEW bundle.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["preview-channel-override"] }),
  });

  // Already on the target channel — including the relaunch after a successful
  // switch, where the deep link URL re-opens this screen. Deliberately NOT a
  // silent redirect: scanning a QR for the channel you're already on should
  // SHOW you that (Current = Target, plus the running commit) rather than
  // leave you wondering whether anything happened. Continue hands the hints
  // to the sign-in screen.
  const alreadyOnTarget = current.isSuccess && current.data === channel;

  const currentChannel = current.data || Updates.channel || "preview";

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Switch preview channel" }} />
      <Text style={styles.heading}>
        {alreadyOnTarget ? "You're already on this channel" : "Point this app at another channel?"}
      </Text>
      <View style={styles.card}>
        <Row label="Current" value={currentChannel} />
        <Row label="Target" value={channel} />
        {recommendedServer !== null ? (
          // Display-only preview of what the sign-in screen will suggest next.
          <Row label="Recommended backend" value={recommendedServer.label} />
        ) : null}
        <Row
          label="Running"
          value={`${buildInfo.branch || "?"} @ ${buildInfo.commit.slice(0, 7) || "?"}`}
        />
        {buildInfo.message ? <Row label="Commit" value={buildInfo.message} /> : null}
      </View>
      {alreadyOnTarget ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace({ pathname: "/", params: hintParams })}
          style={styles.button}
        >
          <Text style={styles.buttonLabel}>Continue</Text>
        </Pressable>
      ) : !Updates.isEnabled ? (
        <Text style={styles.note}>
          OTA updates are off in this bundle (Metro dev server) — channel switching only works in
          installed builds.
        </Text>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={switchChannel.isPending}
          onPress={() => switchChannel.mutate()}
          style={[styles.button, switchChannel.isPending && styles.buttonDisabled]}
        >
          <Text style={styles.buttonLabel}>
            {switchChannel.isPending ? "Switching…" : `Switch to ${channel}`}
          </Text>
        </Pressable>
      )}
      {switchChannel.data === "no-update" ? (
        <Text style={styles.note}>
          Switched, but the channel has nothing this binary can run — either nothing is published
          yet, or the PR has native changes (install its build instead). The override sticks; the
          app will pick updates up once compatible ones are published.
        </Text>
      ) : null}
      {switchChannel.error ? (
        <Text style={styles.errorNote}>{String(switchChannel.error)}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        // Deep links open this screen with no back stack.
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        style={styles.linkButton}
      >
        <Text style={styles.linkLabel}>Cancel</Text>
      </Pressable>
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
  heading: { color: colors.text, fontSize: 18, fontWeight: "600" },
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
