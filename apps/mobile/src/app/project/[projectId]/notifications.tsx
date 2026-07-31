// Every notification this device was ever asked to show, newest first, with
// where it got to — including "Skipped — already on screen", the
// suppression the in-thread approval claim produces. The list reads THIS
// device's own stream (the device processor journals the whole obligation
// there) and stays live, so a push settling while the screen is open updates
// its row in place. Tapping a row deep-links to the same place tapping the
// real push would have (lib/notification-routing.ts).

import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { getMobileDeviceId } from "../../../lib/device-identity.ts";
import { getProjectItx } from "../../../lib/itx.ts";
import {
  deriveDeviceNotifications,
  DEVICE_NOTIFICATION_EVENT_TYPES,
  type DeviceNotificationRow,
} from "../../../lib/notifications.ts";
import { pushNotificationRoute } from "../../../lib/notification-routing.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";
import { useLiveEvents } from "../../../lib/use-live-events.ts";

export default function NotificationsScreen() {
  const { projectId, slug } = useLocalSearchParams<{ projectId: string; slug?: string }>();

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
  const rows = deriveDeviceNotifications(events.data || []);

  const openDestination = (row: DeviceNotificationRow) => {
    const route = pushNotificationRoute({
      destination: row.destination || undefined,
      projectId,
      requestOffset: row.requestOffset,
    });
    if (route !== null) router.push(route);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: slug ? `${slug} notifications` : "Notifications" }} />
      {events.isPending || device.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator accessibilityLabel="Loading" color={colors.textMuted} />
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
          data={rows}
          keyExtractor={(row) => String(row.requestOffset)}
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              No notifications yet. When the project needs you — an approval, a script talking to
              this phone — they land here with what happened to each one.
            </Text>
          }
          refreshing={events.isRefetching}
          onRefresh={() => events.refetch()}
          renderItem={({ item: row }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => openDestination(row)}
              style={styles.row}
              testID={`notification-row-${row.requestOffset}`}
            >
              <View style={styles.rowHeader}>
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
              <Text style={[styles.status, row.status.kind === "suppressed" && styles.suppressed]}>
                {row.status.label}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

/** Same-day rows show the time; older ones the date — enough for a flat list. */
function formatRequestedAt(iso: string): string {
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
  rowHeader: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  title: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  date: { color: colors.textFaint, fontSize: 12 },
  body: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  status: { color: colors.textMuted, fontSize: 12, fontStyle: "italic" },
  suppressed: { color: colors.accent },
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
