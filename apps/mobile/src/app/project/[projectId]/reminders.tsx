import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
  cancelLocationReminder,
  claimAndArmLocationReminders,
  disableLocationRemindersForProject,
  loadAndFollowLocationReminders,
} from "../../../lib/location-reminder-sync.ts";
import type { DeviceLocationReminder } from "../../../lib/location-reminders.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function LocationRemindersScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const reminders = useQuery({
    queryKey: ["location-reminders", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      return loadAndFollowLocationReminders(baseUrl, projectId);
    },
  });

  const arm = useMutation({
    mutationFn: async (active: DeviceLocationReminder[]) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      await claimAndArmLocationReminders(baseUrl, projectId, active);
    },
    onSuccess: () => reminders.refetch(),
  });

  const cancel = useMutation({
    mutationFn: async (reminderId: string) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      await cancelLocationReminder(baseUrl, projectId, reminderId);
    },
    onSettled: () => reminders.refetch(),
  });

  const disable = useMutation({
    mutationFn: async (active: DeviceLocationReminder[]) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      await disableLocationRemindersForProject(baseUrl, projectId, active);
    },
    onSettled: () => reminders.refetch(),
  });

  const active = reminders.data?.reminders || [];
  const hasOwnedReminders = active.some((reminder) => reminder.ownership === "this-device");

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Location reminders" }} />
      <Text style={styles.explanation}>
        Iterate monitors nearby places on this iPhone. Your precise location stays on the device;
        the project stores the reminder and its delivery audit.
      </Text>
      {reminders.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textMuted} />
        </View>
      ) : reminders.isError ? (
        <View style={styles.center}>
          <Text style={styles.error}>{reminders.error.message}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => reminders.refetch()}>
            <Text style={styles.secondaryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={active}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            active.length > 0 ? (
              <View style={styles.actions}>
                <Pressable
                  style={styles.primaryButton}
                  disabled={arm.isPending}
                  onPress={() => arm.mutate(active)}
                >
                  <Text style={styles.primaryText}>
                    {arm.isPending ? "Arming…" : "Enable and refresh reminders"}
                  </Text>
                </Pressable>
                {hasOwnedReminders ? (
                  <Pressable
                    style={styles.secondaryButton}
                    disabled={disable.isPending}
                    onPress={() => disable.mutate(active)}
                  >
                    <Text style={styles.secondaryText}>
                      {disable.isPending ? "Disabling…" : "Disable on this iPhone"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              No active reminders. Ask an agent, for example: “Remind me to buy milk near a
              supermarket.”
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.message}>{item.message}</Text>
              <Text style={styles.place}>Near: {item.placeQuery}</Text>
              <Text style={styles.status}>{statusText(item)}</Text>
              <Pressable disabled={cancel.isPending} onPress={() => cancel.mutate(item.id)}>
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
          )}
        />
      )}
      {arm.isError ? <Text style={styles.errorBanner}>{arm.error.message}</Text> : null}
      {cancel.isError ? <Text style={styles.errorBanner}>{cancel.error.message}</Text> : null}
      {disable.isError ? <Text style={styles.errorBanner}>{disable.error.message}</Text> : null}
    </View>
  );
}

function statusText(reminder: DeviceLocationReminder): string {
  if (reminder.ownership === "unclaimed") return "Ready to enable on this iPhone";
  if (reminder.status === "armed") return `Monitoring ${reminder.regionCount} nearby places`;
  if (reminder.status === "failed") return `Not armed: ${reminder.reason}`;
  return "Waiting to be enabled on this iPhone";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  explanation: { color: colors.textMuted, fontSize: 13, lineHeight: 19, padding: spacing.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  list: { padding: spacing.md, gap: spacing.sm },
  actions: { gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  message: { color: colors.text, fontSize: 16, fontWeight: "600" },
  place: { color: colors.textMuted, fontSize: 14 },
  status: { color: colors.textFaint, fontSize: 12 },
  cancel: { color: colors.danger, fontSize: 14, marginTop: spacing.xs },
  empty: { color: colors.textMuted, fontSize: 14, lineHeight: 20, paddingTop: spacing.lg },
  error: { color: colors.danger, fontSize: 14, textAlign: "center" },
  errorBanner: { color: colors.danger, fontSize: 13, padding: spacing.md },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.text,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  primaryText: { color: colors.background, fontSize: 15, fontWeight: "600" },
  secondaryButton: {
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  secondaryText: { color: colors.text, fontSize: 14 },
});
