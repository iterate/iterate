import { useMutation } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { sendTestNotification } from "../../../lib/notification-runtime.ts";
import { colors, radius, spacing } from "../../../lib/theme.ts";

export default function NotificationsScreen() {
  const sendTest = useMutation({ mutationFn: sendTestNotification });

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Notifications" }} />
      <Text style={styles.explanation}>
        Send an immediate local notification to confirm that Iterate has notification permission on
        this phone. Project scripts and approval requests use the enrolled device push channel.
      </Text>
      <Pressable
        style={styles.primaryButton}
        disabled={sendTest.isPending}
        onPress={() => sendTest.mutate()}
      >
        <Text style={styles.primaryText}>
          {sendTest.isPending ? "Sending…" : "Send test notification now"}
        </Text>
      </Pressable>
      {sendTest.isSuccess ? (
        <Text style={styles.success}>Notification sent. You should see it now.</Text>
      ) : null}
      {sendTest.isError ? <Text style={styles.error}>{sendTest.error.message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    gap: spacing.md,
    padding: spacing.md,
  },
  explanation: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: colors.text,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  primaryText: { color: colors.background, fontSize: 15, fontWeight: "600" },
  success: { color: colors.accent, fontSize: 13, textAlign: "center" },
  error: { color: colors.danger, fontSize: 13, textAlign: "center" },
});
