// Browser for the mobile app's EAS Update preview channels: every PR touching
// apps/mobile publishes to a channel named after its branch (`preview` = main),
// and this screen lists them straight from the session API
// (Session.mobilePreviewChannels — OS proxies EAS with its server-side Expo
// token). Tapping one routes to the existing preview-channel confirm screen,
// so switching stays deliberate.
import { useQuery } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { getItxSession } from "../lib/itx.ts";
import { getPreviewChannelOverride } from "../lib/preview-channel.ts";
import { DEFAULT_SERVER } from "../lib/servers.ts";
import { getServerBaseUrl } from "../lib/storage.ts";
import { colors, radius, spacing } from "../lib/theme.ts";

export default function PreviewChannelsScreen() {
  const channels = useQuery({
    queryKey: ["mobile-preview-channels"],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const session = await getItxSession(baseUrl);
      try {
        return await session.mobilePreviewChannels();
      } catch (error) {
        // OTA JS routinely runs ahead of the deployed worker (a PR channel's
        // bundle can call session methods prd doesn't have until the PR merges
        // and OS deploys). Surface that as a state, not a TypeError.
        if (/is not a function|not a method|no such method/i.test(String(error))) {
          return { available: false, serverBehind: true, channels: [] } as const;
        }
        throw error;
      }
    },
  });
  const override = useQuery({
    queryKey: ["preview-channel-override"],
    queryFn: getPreviewChannelOverride,
  });

  const activeChannel = override.data || "preview";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Preview channels" }} />
      {channels.isPending ? <ActivityIndicator style={styles.spinner} /> : null}
      {channels.error ? <Text style={styles.errorNote}>{String(channels.error)}</Text> : null}
      {channels.data && !channels.data.available ? (
        <Text style={styles.note}>
          {"serverBehind" in channels.data
            ? "This OS deployment doesn't have the channel-list API yet — this bundle's JS is newer than the server. It'll work once the PR that added this screen merges and OS deploys."
            : "This deployment has no Expo token configured, so it can't list channels."}
        </Text>
      ) : null}
      <FlatList
        data={channels.data?.channels || []}
        keyExtractor={(channel) => channel.name}
        refreshing={channels.isRefetching}
        onRefresh={() => channels.refetch()}
        renderItem={({ item }) => {
          const active = item.name === activeChannel;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                router.push({
                  pathname: "/preview-channel/[channel]",
                  params: { channel: item.name },
                })
              }
              style={[styles.row, active && styles.rowActive]}
            >
              <View style={styles.rowHeader}>
                <Text style={styles.rowName}>
                  {item.name === "preview" ? "preview (main)" : item.name}
                </Text>
                {active ? <Text style={styles.activeBadge}>current</Text> : null}
              </View>
              {item.latestUpdate ? (
                <Text numberOfLines={2} style={styles.rowMessage}>
                  {item.latestUpdate.message}
                </Text>
              ) : null}
              <Text style={styles.rowMeta}>
                {new Date(item.latestUpdate?.createdAt || item.updatedAt).toLocaleString()}
              </Text>
            </Pressable>
          );
        }}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  spinner: { marginTop: spacing.lg },
  list: { gap: spacing.sm, padding: spacing.lg },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 4,
    padding: spacing.md,
  },
  rowActive: { borderColor: colors.textMuted },
  rowHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  activeBadge: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  rowMessage: { color: colors.textMuted, fontSize: 13 },
  rowMeta: { color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textMuted, fontSize: 13, padding: spacing.lg, textAlign: "center" },
  errorNote: { color: colors.danger, fontSize: 13, padding: spacing.lg, textAlign: "center" },
});
