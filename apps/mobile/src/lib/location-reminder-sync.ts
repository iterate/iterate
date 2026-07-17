import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Stream, StreamEventBatch } from "../../../os/src/itx-api.generated.ts";
import {
  armLocationReminders,
  clearPendingLocationReminderDeliveries,
  disableProjectLocationReminders,
  readPendingLocationReminderDeliveries,
  removeLocationReminderRegistrations,
} from "./location-reminder-runtime.ts";
import {
  LOCATION_REMINDER_EVENT,
  LOCATION_REMINDER_STREAM_PATH,
  locationReminderReconciliationKey,
  reduceLocationRemindersForDevice,
  type DeviceLocationReminder,
  type LocationReminderIdentity,
  type LocationReminderStreamEvent,
} from "./location-reminders.ts";
import { getItxSession, resetItxSession } from "./itx.ts";
import { queryClient } from "./query.ts";

const DEVICE_ID_KEY = "iterate.locationReminderDeviceId.v1";
const STREAM_PAGE_SIZE = 500;
const WATCHDOG_INTERVAL_MS = 15_000;
const REMINDER_EVENT_TYPES = Object.values(LOCATION_REMINDER_EVENT);

export type LocationReminderQueryData = {
  events: LocationReminderStreamEvent[];
  identity: LocationReminderIdentity;
  reminders: DeviceLocationReminder[];
};

type ReminderSubscription = { stop: () => void };

const subscriptions = new Map<string, Promise<ReminderSubscription>>();
const reconciliationKeys = new Map<string, string>();
const reconciliationQueues = new Map<string, Promise<void>>();
const manualReconciliationKeys = new Set<string>();
let deviceIdPromise: Promise<string> | null = null;

export function locationRemindersQueryKey(projectId: string) {
  return ["location-reminders", projectId] as const;
}

export async function loadAndFollowLocationReminders(
  baseUrl: string,
  projectId: string,
): Promise<LocationReminderQueryData> {
  const identity = await getLocationReminderIdentity(baseUrl);
  const events = await loadLocationReminderEvents(baseUrl, projectId, identity);
  const key = locationRemindersQueryKey(projectId);
  const mapKey = JSON.stringify([baseUrl, ...key]);
  if (!subscriptions.has(mapKey)) {
    const subscription = subscribeLocationReminders(baseUrl, projectId, identity, mapKey).catch(
      (error) => {
        subscriptions.delete(mapKey);
        throw error;
      },
    );
    subscriptions.set(mapKey, subscription);
  }
  await subscriptions.get(mapKey);
  const cached = queryClient.getQueryData<LocationReminderQueryData>(key);
  const combined = mergeLocationReminderEvents(cached?.events || [], events);
  const result = {
    events: combined,
    identity,
    reminders: reduceLocationRemindersForDevice(combined, identity),
  };
  scheduleReconciliation(baseUrl, projectId, result, true);
  return result;
}

export async function claimAndArmLocationReminders(
  baseUrl: string,
  projectId: string,
  reminders: DeviceLocationReminder[],
): Promise<void> {
  const identity = await getLocationReminderIdentity(baseUrl);
  const reconciliationKey = reconciliationMapKey(baseUrl, projectId, identity);
  manualReconciliationKeys.add(reconciliationKey);
  try {
    await claimAndArmLocationRemindersNow(baseUrl, projectId, reminders, identity);
  } finally {
    manualReconciliationKeys.delete(reconciliationKey);
  }
}

async function claimAndArmLocationRemindersNow(
  baseUrl: string,
  projectId: string,
  reminders: DeviceLocationReminder[],
  identity: LocationReminderIdentity,
): Promise<void> {
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get(LOCATION_REMINDER_STREAM_PATH);
  const unclaimed = reminders.filter((reminder) => reminder.ownership === "unclaimed");
  if (unclaimed.length > 0) {
    const claimAttemptId = new Date().toISOString();
    await stream.append(
      ...unclaimed.map((reminder) => ({
        idempotencyKey: `location-reminder-claimed:${reminder.id}:${identity.deviceId}:${claimAttemptId}`,
        payload: { ...identity, id: reminder.id },
        type: LOCATION_REMINDER_EVENT.claimed,
      })),
    );
  }

  const events = await readAllLocationReminderEvents(stream);
  const owned = reduceLocationRemindersForDevice(events, identity).filter(
    (reminder) => reminder.ownership === "this-device",
  );
  const ownedIds = new Set(owned.map((reminder) => reminder.id));
  const lostClaims = unclaimed.filter((reminder) => !ownedIds.has(reminder.id));
  if (lostClaims.length > 0) {
    throw new Error(
      `Another device claimed ${lostClaims.map((reminder) => reminder.message).join(", ")} first.`,
    );
  }
  await reconcileLocationReminders(
    baseUrl,
    projectId,
    { events, identity, reminders: owned },
    "request",
  );
  reconciliationKeys.set(
    reconciliationMapKey(baseUrl, projectId, identity),
    locationReminderReconciliationKey(owned),
  );
}

export async function disableLocationRemindersForProject(
  baseUrl: string,
  projectId: string,
  reminders: DeviceLocationReminder[],
): Promise<void> {
  const identity = await getLocationReminderIdentity(baseUrl);
  const owned = reminders.filter((reminder) => reminder.ownership === "this-device");
  if (owned.length > 0) {
    const releaseAttemptId = new Date().toISOString();
    const itx = await getItxSession(baseUrl);
    const project = await itx.projects.get(projectId);
    await project.streams.get(LOCATION_REMINDER_STREAM_PATH).append(
      ...owned.map((reminder) => ({
        idempotencyKey: `location-reminder-released:${reminder.id}:${identity.deviceId}:${releaseAttemptId}`,
        payload: { ...identity, id: reminder.id },
        type: LOCATION_REMINDER_EVENT.released,
      })),
    );
  }
  await disableProjectLocationReminders(projectId);
}

export async function cancelLocationReminder(
  baseUrl: string,
  projectId: string,
  reminderId: string,
): Promise<void> {
  const identity = await getLocationReminderIdentity(baseUrl);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const operationId = new Date().toISOString();
  await project.streams.get(LOCATION_REMINDER_STREAM_PATH).append({
    idempotencyKey: `location-reminder-cancelled:${reminderId}:${operationId}`,
    payload: { ...identity, id: reminderId },
    type: LOCATION_REMINDER_EVENT.cancelled,
  });
  await removeLocationReminderRegistrations(projectId, reminderId);
}

export function stopAllLocationReminderSubscriptions(): void {
  for (const subscription of [...subscriptions.values()]) {
    void subscription.then((value) => value.stop()).catch(() => {});
  }
  subscriptions.clear();
  reconciliationKeys.clear();
  reconciliationQueues.clear();
  manualReconciliationKeys.clear();
}

async function getLocationReminderIdentity(baseUrl: string): Promise<LocationReminderIdentity> {
  const session = await getItxSession(baseUrl);
  const [{ principal: userId }, deviceId] = await Promise.all([
    session.__describe(),
    getLocationReminderDeviceId(),
  ]);
  return { deviceId, userId };
}

async function getLocationReminderDeviceId(): Promise<string> {
  if (deviceIdPromise) return deviceIdPromise;
  const loading = (async () => {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, created);
    return created;
  })().catch((error) => {
    if (deviceIdPromise === loading) deviceIdPromise = null;
    throw error;
  });
  deviceIdPromise = loading;
  return loading;
}

async function loadLocationReminderEvents(
  baseUrl: string,
  projectId: string,
  identity: LocationReminderIdentity,
): Promise<LocationReminderStreamEvent[]> {
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
          ...identity,
          id: delivery.reminderId,
          regionIdentifier: delivery.regionIdentifier,
        },
        type: LOCATION_REMINDER_EVENT.delivered,
      })),
    );
    await clearPendingLocationReminderDeliveries(pending);
  }
  return readAllLocationReminderEvents(stream);
}

async function readAllLocationReminderEvents(
  stream: Stream,
): Promise<LocationReminderStreamEvent[]> {
  const events: LocationReminderStreamEvent[] = [];
  let afterOffset: number | undefined;
  while (true) {
    const page = (await stream.getEvents({
      ...(afterOffset === undefined ? {} : { afterOffset }),
      eventTypes: REMINDER_EVENT_TYPES,
    })) as LocationReminderStreamEvent[];
    events.push(...page);
    if (page.length < STREAM_PAGE_SIZE) return events;
    afterOffset = page[page.length - 1]!.offset;
  }
}

async function subscribeLocationReminders(
  baseUrl: string,
  projectId: string,
  identity: LocationReminderIdentity,
  mapKey: string,
): Promise<ReminderSubscription> {
  const key = locationRemindersQueryKey(projectId);
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get(LOCATION_REMINDER_STREAM_PATH);
  const alreadySeen = queryClient.getQueryData<LocationReminderQueryData>(key)?.events || [];
  const handle = await stream.subscribe({
    eventTypes: REMINDER_EVENT_TYPES,
    replayAfterOffset: alreadySeen.reduce((max, event) => Math.max(max, event.offset), 0),
    processEventBatch: (batch: StreamEventBatch) => {
      queryClient.setQueryData<LocationReminderQueryData>(key, (existing) => {
        const events = mergeLocationReminderEvents(
          existing?.events || [],
          batch.events as LocationReminderStreamEvent[],
        );
        const next = {
          events,
          identity,
          reminders: reduceLocationRemindersForDevice(events, identity),
        };
        scheduleReconciliation(baseUrl, projectId, next, false);
        return next;
      });
    },
  });

  const watchdog = setInterval(() => {
    void Promise.resolve(handle.ping())
      .then((alive) => {
        if (alive !== true) throw new Error("subscription closed");
      })
      .catch(() => {
        stop();
        resetItxSession();
        void queryClient.refetchQueries({ queryKey: key });
      });
  }, WATCHDOG_INTERVAL_MS);

  const stop = () => {
    clearInterval(watchdog);
    subscriptions.delete(mapKey);
    try {
      handle.unsubscribe();
    } catch {
      // socket already gone
    }
  };
  return { stop };
}

function scheduleReconciliation(
  baseUrl: string,
  projectId: string,
  data: LocationReminderQueryData,
  force: boolean,
): void {
  const owned = data.reminders.filter((reminder) => reminder.ownership === "this-device");
  const key = reconciliationMapKey(baseUrl, projectId, data.identity);
  if (manualReconciliationKeys.has(key)) return;
  const desired = locationReminderReconciliationKey(owned);
  if (!force && reconciliationKeys.get(key) === desired) return;
  reconciliationKeys.set(key, desired);
  const previous = reconciliationQueues.get(key) || Promise.resolve();
  const next = previous
    .then(() =>
      reconcileLocationReminders(
        baseUrl,
        projectId,
        { events: data.events, identity: data.identity, reminders: owned },
        "check",
      ),
    )
    .catch((error) => console.error("Location reminder reconciliation failed", error))
    .finally(() => {
      if (reconciliationQueues.get(key) === next) reconciliationQueues.delete(key);
    });
  reconciliationQueues.set(key, next);
}

function reconciliationMapKey(
  baseUrl: string,
  projectId: string,
  identity: LocationReminderIdentity,
): string {
  return `${baseUrl}:${projectId}:${identity.userId}:${identity.deviceId}`;
}

function mergeLocationReminderEvents(
  existing: LocationReminderStreamEvent[],
  incoming: LocationReminderStreamEvent[],
): LocationReminderStreamEvent[] {
  const byOffset = new Map(existing.map((event) => [event.offset, event]));
  for (const event of incoming) byOffset.set(event.offset, event);
  return [...byOffset.values()].sort((left, right) => left.offset - right.offset);
}

async function reconcileLocationReminders(
  baseUrl: string,
  projectId: string,
  data: LocationReminderQueryData,
  permissionMode: "check" | "request",
): Promise<void> {
  const itx = await getItxSession(baseUrl);
  const project = await itx.projects.get(projectId);
  const stream = project.streams.get(LOCATION_REMINDER_STREAM_PATH);
  const attemptId = new Date().toISOString();
  try {
    const result = await armLocationReminders(projectId, data.reminders, permissionMode);
    const events = [
      ...result.armed.map((reminder) => ({
        idempotencyKey: `location-reminder-armed:${reminder.id}:${attemptId}`,
        payload: { ...data.identity, id: reminder.id, regionCount: reminder.regionCount },
        type: LOCATION_REMINDER_EVENT.armed,
      })),
      ...result.failed.map((reminder) => ({
        idempotencyKey: `location-reminder-arming-failed:${reminder.id}:${attemptId}`,
        payload: { ...data.identity, id: reminder.id, reason: reminder.reason },
        type: LOCATION_REMINDER_EVENT.armingFailed,
      })),
    ];
    if (events.length > 0) await stream.append(...events);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (data.reminders.length === 0) throw error;
    await stream.append(
      ...data.reminders.map((reminder) => ({
        idempotencyKey: `location-reminder-arming-failed:${reminder.id}:${attemptId}`,
        payload: { ...data.identity, id: reminder.id, reason },
        type: LOCATION_REMINDER_EVENT.armingFailed,
      })),
    );
  }
}
