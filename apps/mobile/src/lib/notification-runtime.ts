import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export async function sendTestReminderNotification(): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error("Test reminders require the Iterate iOS development build.");
  }

  const permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== Notifications.PermissionStatus.GRANTED) {
    throw new Error("Enable notifications for Iterate in iOS Settings to send a reminder.");
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      body: "This is a plain reminder. Notifications are working.",
      title: "Reminder from Iterate",
    },
    trigger: null,
  });
}
