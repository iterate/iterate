import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { router } from "expo-router";
import { Platform } from "react-native";
import { searchNearbyPlaces } from "../../modules/iterate-place-search/index.ts";
import {
  allocateReminderRegions,
  type Coordinates,
  type LocationReminder,
  type ReminderPlace,
  type ReminderRegion,
} from "./location-reminders.ts";

export const LOCATION_REMINDER_GEOFENCE_TASK = "iterate-location-reminder-geofence";

const REGION_RECORDS_KEY = "iterate.locationReminderRegions.v1";
const PENDING_DELIVERIES_KEY = "iterate.locationReminderDeliveries.v1";
const IOS_REGION_LIMIT = 20;
const PLACE_SEARCH_RADIUS_METERS = 25_000;

type RegionRecord = ReminderRegion & {
  message: string;
  projectId: string;
  reminderId: string;
  sourceAgentPath: string;
};

export type PendingLocationReminderDelivery = {
  deliveredAt: string;
  projectId: string;
  regionIdentifier: string;
  reminderId: string;
};

export type ArmLocationRemindersResult = {
  armed: Array<{ id: string; regionCount: number }>;
  failed: Array<{ id: string; reason: string }>;
};

type PlaceSearchResult =
  | { places: ReminderPlace[]; reminder: LocationReminder; status: "found" }
  | { reason: string; reminder: LocationReminder; status: "failed" };

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });

  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (typeof data.projectId !== "string" || typeof data.sourceAgentPath !== "string") return;
    router.push({
      pathname: "/project/[projectId]/chat",
      params: { path: data.sourceAgentPath, projectId: data.projectId },
    });
  });

  if (!TaskManager.isTaskDefined(LOCATION_REMINDER_GEOFENCE_TASK)) {
    TaskManager.defineTask<{
      eventType: Location.GeofencingEventType;
      region: Location.LocationRegion;
    }>(LOCATION_REMINDER_GEOFENCE_TASK, async ({ data, error }) => {
      if (error !== null) throw new Error(`Location reminder geofence failed: ${error.message}`);
      if (data.eventType !== Location.GeofencingEventType.Enter) return;

      const records = await readRegionRecords();
      const record = records.find((candidate) => candidate.identifier === data.region.identifier);
      if (record === undefined) {
        throw new Error(`No reminder metadata exists for region ${data.region.identifier}`);
      }

      await Notifications.scheduleNotificationAsync({
        content: {
          body: record.message,
          data: {
            projectId: record.projectId,
            reminderId: record.reminderId,
            sourceAgentPath: record.sourceAgentPath,
          },
          title: "Location reminder",
        },
        trigger: null,
      });

      const pending = await readPendingLocationReminderDeliveries();
      if (
        !pending.some(
          (delivery) =>
            delivery.projectId === record.projectId && delivery.reminderId === record.reminderId,
        )
      ) {
        await AsyncStorage.setItem(
          PENDING_DELIVERIES_KEY,
          JSON.stringify([
            ...pending,
            {
              deliveredAt: new Date().toISOString(),
              projectId: record.projectId,
              regionIdentifier: record.identifier,
              reminderId: record.reminderId,
            },
          ]),
        );
      }

      const remaining = records.filter(
        (candidate) =>
          candidate.projectId !== record.projectId || candidate.reminderId !== record.reminderId,
      );
      await AsyncStorage.setItem(REGION_RECORDS_KEY, JSON.stringify(remaining));
      if (remaining.length === 0) {
        await Location.stopGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK);
      } else {
        await Location.startGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK, remaining);
      }
    });
  }
}

export async function armLocationReminders(
  projectId: string,
  reminders: LocationReminder[],
): Promise<ArmLocationRemindersResult> {
  if (Platform.OS !== "ios") {
    throw new Error("Location reminders currently require the Iterate iOS development build.");
  }

  if (reminders.length === 0) {
    await stopProjectLocationReminders(projectId);
    return { armed: [], failed: [] };
  }

  const foreground = await Location.requestForegroundPermissionsAsync();
  if (foreground.status !== Location.PermissionStatus.GRANTED) {
    throw new Error("Location reminders need While Using the App location access first.");
  }
  const background = await Location.requestBackgroundPermissionsAsync();
  if (background.status !== Location.PermissionStatus.GRANTED) {
    throw new Error(
      "Location reminders are not armed: set Location to Always for Iterate in iOS Settings.",
    );
  }
  const notifications = await Notifications.requestPermissionsAsync();
  if (notifications.status !== Notifications.PermissionStatus.GRANTED) {
    throw new Error("Location reminders need notification permission to alert you on arrival.");
  }

  const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const origin = {
    latitude: current.coords.latitude,
    longitude: current.coords.longitude,
  };
  const searches: PlaceSearchResult[] = await Promise.all(
    reminders.map(async (reminder) => {
      try {
        const places = await searchNearbyPlaces({
          ...origin,
          query: reminder.placeQuery,
          radiusMeters: PLACE_SEARCH_RADIUS_METERS,
        });
        if (places.length === 0)
          return { reason: "No nearby places found", reminder, status: "failed" };
        return { places, reminder, status: "found" };
      } catch (error) {
        return {
          reason: error instanceof Error ? error.message : String(error),
          reminder,
          status: "failed",
        };
      }
    }),
  );

  const successful = searches.filter(
    (result): result is Extract<PlaceSearchResult, { status: "found" }> =>
      result.status === "found",
  );
  const otherProjectRecords = (await readRegionRecords()).filter(
    (record) => record.projectId !== projectId,
  );
  const availableRegions = IOS_REGION_LIMIT - otherProjectRecords.length;
  const records = allocateRegionRecords(projectId, origin, successful, availableRegions);
  if (records.length === 0) {
    const reasons = searches.map((result) =>
      result.status === "failed"
        ? `${result.reminder.id}: ${result.reason}`
        : `${result.reminder.id}: no regions allocated`,
    );
    throw new Error(`No location reminders could be armed (${reasons.join("; ")}).`);
  }

  const allRecords = [...otherProjectRecords, ...records];
  await AsyncStorage.setItem(REGION_RECORDS_KEY, JSON.stringify(allRecords));
  await Location.startGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK, allRecords);

  return {
    armed: reminders
      .map((reminder) => ({
        id: reminder.id,
        regionCount: records.filter((record) => record.reminderId === reminder.id).length,
      }))
      .filter((result) => result.regionCount > 0),
    failed: searches
      .filter(
        (result): result is Extract<PlaceSearchResult, { status: "failed" }> =>
          result.status === "failed",
      )
      .map((result) => ({ id: result.reminder.id, reason: result.reason })),
  };
}

export async function readPendingLocationReminderDeliveries(): Promise<
  PendingLocationReminderDelivery[]
> {
  const raw = await AsyncStorage.getItem(PENDING_DELIVERIES_KEY);
  if (raw === null) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Stored location reminder deliveries are corrupt.");
  return parsed as PendingLocationReminderDelivery[];
}

export async function clearPendingLocationReminderDeliveries(
  delivered: PendingLocationReminderDelivery[],
): Promise<void> {
  const pending = await readPendingLocationReminderDeliveries();
  const deliveredKeys = new Set(
    delivered.map((item) => `${item.projectId}:${item.reminderId}:${item.regionIdentifier}`),
  );
  await AsyncStorage.setItem(
    PENDING_DELIVERIES_KEY,
    JSON.stringify(
      pending.filter(
        (item) =>
          !deliveredKeys.has(`${item.projectId}:${item.reminderId}:${item.regionIdentifier}`),
      ),
    ),
  );
}

export async function removeLocationReminderRegistrations(
  projectId: string,
  reminderId: string,
): Promise<void> {
  const remaining = (await readRegionRecords()).filter(
    (record) => record.projectId !== projectId || record.reminderId !== reminderId,
  );
  await AsyncStorage.setItem(REGION_RECORDS_KEY, JSON.stringify(remaining));
  if (remaining.length === 0) {
    if (await Location.hasStartedGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK);
    }
    return;
  }
  await Location.startGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK, remaining);
}

export async function stopAllLocationReminders(): Promise<void> {
  if (await Location.hasStartedGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK)) {
    await Location.stopGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK);
  }
  await AsyncStorage.removeItem(REGION_RECORDS_KEY);
  await AsyncStorage.removeItem(PENDING_DELIVERIES_KEY);
}

async function stopProjectLocationReminders(projectId: string): Promise<void> {
  const remaining = (await readRegionRecords()).filter((record) => record.projectId !== projectId);
  await AsyncStorage.setItem(REGION_RECORDS_KEY, JSON.stringify(remaining));
  if (remaining.length === 0) {
    if (await Location.hasStartedGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK);
    }
    return;
  }
  await Location.startGeofencingAsync(LOCATION_REMINDER_GEOFENCE_TASK, remaining);
}

async function readRegionRecords(): Promise<RegionRecord[]> {
  const raw = await AsyncStorage.getItem(REGION_RECORDS_KEY);
  if (raw === null) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Stored location reminder regions are corrupt.");
  return parsed as RegionRecord[];
}

function allocateRegionRecords(
  projectId: string,
  origin: Coordinates,
  searches: Array<{ places: ReminderPlace[]; reminder: LocationReminder }>,
  limit: number,
): RegionRecord[] {
  return allocateReminderRegions({ limit, origin, searches }).map(({ region, reminder }) => ({
    ...region,
    message: reminder.message,
    projectId,
    reminderId: reminder.id,
    sourceAgentPath: reminder.sourceAgentPath,
  }));
}
