import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import {
  armLocationReminders,
  clearPendingLocationReminderDeliveries,
  readPendingLocationReminderDeliveries,
  removeLocationReminderRegistrations,
} from "../../../lib/location-reminder-runtime.ts";
import {
  LOCATION_REMINDER_EVENT,
  LOCATION_REMINDER_STREAM_PATH,
  reduceLocationReminders,
  type LocationReminder,
  type LocationReminderStreamEvent,
} from "../../../lib/location-reminders.ts";
import { getItxSession, resetItxSession } from "../../../lib/itx.ts";
import { DEFAULT_SERVER } from "../../../lib/servers.ts";
import { getServerBaseUrl } from "../../../lib/storage.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

const REMINDER_EVENT_TYPES = Object.values(LOCATION_REMINDER_EVENT);
const STREAM_PAGE_SIZE = 500;

export default function LocationRemindersScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const reminders = useQuery({
    queryKey: ["location-reminders", projectId],
    queryFn: async () => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      try {
        const itx = await getItxSession(baseUrl);
        const project = await itx.projects.get(projectId);
        const stream = project.streams.get(LOCATION_REMINDER_STREAM_PATH);
        const pending = (await readPendingLocationReminderDeliveries()).filter(
          (delivery) => delivery.projectId === projectId,
        );
        if (pending.length > 0) {
          await stream.append(
            ...pending.map((delivery) => ({
              idempotencyKey: `location-reminder-delivered:${delivery.reminderId}:${delivery.deliveredAt}`,
              payload: {
                id: delivery.reminderId,
                regionIdentifier: delivery.regionIdentifier,
              },
              type: LOCATION_REMINDER_EVENT.delivered,
            })),
          );
          await clearPendingLocationReminderDeliveries(pending);
        }
        const events = [];
        let afterOffset: number | undefined;
        while (true) {
          const page = await stream.getEvents({
            ...(afterOffset === undefined ? {} : { afterOffset }),
            eventTypes: REMINDER_EVENT_TYPES,
          });
          events.push(...page);
          if (page.length < STREAM_PAGE_SIZE) break;
          afterOffset = page[page.length - 1]!.offset;
        }
        return reduceLocationReminders(events as LocationReminderStreamEvent[]);
      } catch (error) {
        resetItxSession();
        throw error;
      }
    },
  });

  const arm = useMutation({
    mutationFn: async (active: LocationReminder[]) => {
      const attemptId = new Date().toISOString();
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const itx = await getItxSession(baseUrl);
      const project = await itx.projects.get(projectId);
      const stream = project.streams.get(LOCATION_REMINDER_STREAM_PATH);
      const result = await armLocationReminders(projectId, active);
      const events = [
        ...result.armed.map((reminder) => ({
          idempotencyKey: `location-reminder-armed:${reminder.id}:${attemptId}`,
          payload: { id: reminder.id, regionCount: reminder.regionCount },
          type: LOCATION_REMINDER_EVENT.armed,
        })),
        ...result.failed.map((reminder) => ({
          idempotencyKey: `location-reminder-arming-failed:${reminder.id}:${attemptId}`,
          payload: { id: reminder.id, reason: reminder.reason },
          type: LOCATION_REMINDER_EVENT.armingFailed,
        })),
      ];
      if (events.length > 0) await stream.append(...events);
    },
    onSuccess: () => reminders.refetch(),
  });

  const cancel = useMutation({
    mutationFn: async (input: { cancelled: LocationReminder; remaining: LocationReminder[] }) => {
      const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
      const itx = await getItxSession(baseUrl);
      const project = await itx.projects.get(projectId);
      await project.streams.get(LOCATION_REMINDER_STREAM_PATH).append({
        idempotencyKey: `location-reminder-cancelled:${input.cancelled.id}`,
        payload: { id: input.cancelled.id },
        type: LOCATION_REMINDER_EVENT.cancelled,
      });
      await removeLocationReminderRegistrations(projectId, input.cancelled.id);
      await armLocationReminders(projectId, input.remaining);
    },
    onSettled: () => reminders.refetch(),
  });

  const active = reminders.data || [];

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
              <Pressable
                style={styles.primaryButton}
                disabled={arm.isPending}
                onPress={() => arm.mutate(active)}
              >
                <Text style={styles.primaryText}>
                  {arm.isPending ? "Arming…" : "Enable and refresh reminders"}
                </Text>
              </Pressable>
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
              <Pressable
                disabled={cancel.isPending}
                onPress={() =>
                  cancel.mutate({
                    cancelled: item,
                    remaining: active.filter((candidate) => candidate.id !== item.id),
                  })
                }
              >
                <Text style={styles.cancel}>Cancel</Text>
              </Pressable>
            </View>
          )}
        />
      )}
      {arm.isError ? <Text style={styles.errorBanner}>{arm.error.message}</Text> : null}
      {cancel.isError ? <Text style={styles.errorBanner}>{cancel.error.message}</Text> : null}
    </View>
  );
}

function statusText(reminder: LocationReminder): string {
  if (reminder.status === "armed") return `Monitoring ${reminder.regionCount} nearby places`;
  if (reminder.status === "failed") return `Not armed: ${reminder.reason}`;
  return "Waiting to be enabled on this iPhone";
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  explanation: { color: colors.textMuted, fontSize: 13, lineHeight: 19, padding: spacing.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  list: { padding: spacing.md, gap: spacing.sm },
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
