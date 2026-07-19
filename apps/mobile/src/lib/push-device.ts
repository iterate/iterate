import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";
import { getMobileDeviceId } from "./device-identity.ts";
import { getItxSession } from "./itx.ts";
import {
  notificationOpenedEvent,
  pushNotificationRoute,
  type PushNotificationData,
} from "./notification-routing.ts";
import { queryClient } from "./query.ts";
import { DEFAULT_SERVER } from "./servers.ts";
import { getServerBaseUrl } from "./storage.ts";

const PUSH_ENROLLMENTS_KEY = "iterate.pushEnrollments.v1";
let pushLifecycle: Promise<void> = Promise.resolve();

if (Platform.OS !== "web") {
  Notifications.addNotificationResponseReceivedListener(() => {
    void queryClient.invalidateQueries({ queryKey: ["initial-notification"] });
  });
}

export async function enrollPushDevice(baseUrl: string, projectId: string) {
  if (Platform.OS === "web") return null;
  return await runPushLifecycle(async () => {
    const permission = await Notifications.requestPermissionsAsync();
    if (permission.status !== Notifications.PermissionStatus.GRANTED) {
      throw new Error("Enable notifications for Iterate to make this phone scriptable.");
    }
    const easProjectId = Constants.expoConfig?.extra?.eas?.projectId;
    const appVersion = Constants.expoConfig?.version;
    if (typeof easProjectId !== "string" || typeof appVersion !== "string") {
      throw new Error("The Iterate development build is missing its EAS project or app version.");
    }
    const [deviceId, token, itx] = await Promise.all([
      getMobileDeviceId(),
      Notifications.getExpoPushTokenAsync({ projectId: easProjectId }),
      getItxSession(baseUrl),
    ]);
    const project = await itx.projects.get(projectId);
    const enrolled = await project.devices.get(deviceId).enroll({
      appVersion,
      expoPushToken: token.data,
      label: Platform.OS === "ios" ? "Iterate on iPhone" : "Iterate on Android",
      notificationsStatus: "granted",
      platform: Platform.OS === "ios" ? "ios" : "android",
    });
    await rememberPushEnrollment(baseUrl, projectId);
    return enrolled;
  });
}

export async function revokeEnrolledPushDevices(baseUrl: string): Promise<void> {
  if (Platform.OS === "web") return;
  await runPushLifecycle(async () => {
    const enrollments = await readPushEnrollments();
    const projectIds = enrollments
      .filter((enrollment) => enrollment.baseUrl === baseUrl)
      .map((enrollment) => enrollment.projectId);
    if (projectIds.length === 0) return;
    const [deviceId, itx] = await Promise.all([getMobileDeviceId(), getItxSession(baseUrl)]);
    await Promise.all(
      projectIds.map(async (projectId) => {
        const project = await itx.projects.get(projectId);
        await project.devices.get(deviceId).revoke("sign-out");
      }),
    );
    await AsyncStorage.setItem(
      PUSH_ENROLLMENTS_KEY,
      JSON.stringify(enrollments.filter((enrollment) => enrollment.baseUrl !== baseUrl)),
    );
  });
}

export async function routeInitialNotification(): Promise<void> {
  if (Platform.OS === "web") return;
  const response = await Notifications.getLastNotificationResponseAsync();
  if (response === null) return;
  await handlePushNotificationResponse(response);
  await Notifications.clearLastNotificationResponseAsync();
}

async function handlePushNotificationResponse(response: Notifications.NotificationResponse) {
  const raw = response.notification.request.content.data;
  const data = raw as PushNotificationData;
  const route = pushNotificationRoute(data);
  if (route === null || typeof data.projectId !== "string") return;
  const baseUrl = (await getServerBaseUrl()) || DEFAULT_SERVER;
  const itx = await getItxSession(baseUrl);
  router.push(route);
  if (typeof data.requestOffset === "number") {
    const deviceId = await getMobileDeviceId();
    const project = await itx.projects.get(data.projectId);
    await project.devices
      .get(deviceId)
      .append(notificationOpenedEvent(data.requestOffset, response.notification.date));
  }
}

async function rememberPushEnrollment(baseUrl: string, projectId: string): Promise<void> {
  const enrollments = await readPushEnrollments();
  if (
    enrollments.some(
      (enrollment) => enrollment.baseUrl === baseUrl && enrollment.projectId === projectId,
    )
  ) {
    return;
  }
  await AsyncStorage.setItem(
    PUSH_ENROLLMENTS_KEY,
    JSON.stringify([...enrollments, { baseUrl, projectId }]),
  );
}

async function runPushLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = pushLifecycle.then(operation);
  pushLifecycle = result.then(
    () => undefined,
    () => undefined,
  );
  return await result;
}

async function readPushEnrollments(): Promise<Array<{ baseUrl: string; projectId: string }>> {
  const stored = await AsyncStorage.getItem(PUSH_ENROLLMENTS_KEY);
  if (stored === null) return [];
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error("Stored push enrollments are malformed.");
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("baseUrl" in entry) ||
      typeof entry.baseUrl !== "string" ||
      !("projectId" in entry) ||
      typeof entry.projectId !== "string"
    ) {
      throw new Error("Stored push enrollment is malformed.");
    }
    return { baseUrl: entry.baseUrl, projectId: entry.projectId };
  });
}
