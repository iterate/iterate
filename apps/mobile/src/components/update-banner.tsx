// "You're not on the newest JS for this channel" — the one thing the app used
// to never say. Shows only for a watched build (an overridden channel, or a
// binary built for something other than main), so a phone tracking main is
// exactly as quiet as before.
//
// A banner rather than an automatic reload: restarting under someone's
// half-typed note to save them one tap is a bad trade. The check itself runs
// on mount and on every foreground (lib/build-state.ts).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  installPageUrl,
  updateHeadline,
  useBuildActions,
  useBuildState,
} from "../lib/build-state.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export function UpdateBanner() {
  const state = useBuildState();
  const actions = useBuildActions();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  // Dismissal keyed by the update being announced: dismissing this one must
  // not silence the next push. Cache-held rather than useState so it survives
  // the banner unmounting between screens.
  const announcing =
    state.update.kind === "behind"
      ? state.update.publishedAt || state.update.commit
      : state.update.kind === "incompatible"
        ? state.update.installUrl
        : null;
  const dismissKey = ["update-banner-dismissed", announcing];
  const dismissed = useQuery({
    queryKey: dismissKey,
    queryFn: async () => false,
    initialData: false,
    staleTime: Infinity,
  });

  // `watched` too, not just "behind": a manual check from Build info can
  // land "behind" in the shared cache on an unwatched (main) phone, and the
  // spec is that main phones stay quiet — the Build info row shows it there.
  // "Incompatible" breaks that silence deliberately, main phones included: a
  // native-change merge strands the binary on stale JS FOREVER with no other
  // signal (the update server filters by runtime, so checks keep saying
  // "current"), and the fix is a download, not patience.
  const behind = state.watched && state.update.kind === "behind";
  // Channel-guarded so the Download button below always has a target (the
  // status query only arms with a known channel, so this is belt-and-braces).
  const incompatible = state.update.kind === "incompatible" && state.channel !== null;
  if ((!behind && !incompatible) || dismissed.data) return null;

  // The interstitial, not the raw build page: a direct install clears any
  // channel override on first boot, and the interstitial's "Open in app"
  // tap re-points the fresh binary in the right order.
  const download =
    state.update.kind === "incompatible" && state.channel ? installPageUrl(state.channel) : null;
  return (
    <View style={[styles.wrap, { top: insets.top + spacing.sm }]}>
      <View style={styles.banner}>
        <View style={styles.copy}>
          <Text numberOfLines={2} style={styles.headline}>
            {updateHeadline(state.update)}
          </Text>
          <Text numberOfLines={1} style={styles.sub}>
            {state.channel || "this build's channel"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          disabled={actions.updateNowPending}
          onPress={() => (download ? void Linking.openURL(download) : void actions.updateNow())}
          style={[styles.action, actions.updateNowPending && styles.actionDisabled]}
        >
          <Text style={styles.actionLabel}>
            {download ? "Download" : actions.updateNowPending ? "Updating…" : "Update now"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Dismiss update notice"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => queryClient.setQueryData(dismissKey, true)}
        >
          <Text style={styles.close}>×</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { left: spacing.md, position: "absolute", right: spacing.md, zIndex: 10 },
  banner: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  copy: { flex: 1 },
  headline: { color: colors.text, fontSize: 13, fontWeight: "600" },
  sub: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  action: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  actionDisabled: { opacity: 0.6 },
  actionLabel: { color: colors.text, fontSize: 12, fontWeight: "600" },
  close: { color: colors.textMuted, fontSize: 22, fontWeight: "300" },
});
