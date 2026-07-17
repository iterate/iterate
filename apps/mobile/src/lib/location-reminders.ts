export const LOCATION_REMINDER_STREAM_PATH = "/mobile/location-reminders";

export const LOCATION_REMINDER_EVENT = {
  armed: "events.iterate.com/location-reminder/armed",
  armingFailed: "events.iterate.com/location-reminder/arming-failed",
  cancelled: "events.iterate.com/location-reminder/cancelled",
  delivered: "events.iterate.com/location-reminder/delivered",
  requested: "events.iterate.com/location-reminder/requested",
} as const;

export type LocationReminderStreamEvent = {
  createdAt: string;
  offset: number;
  payload: Record<string, unknown>;
  type: string;
};

type LocationReminderDetails = {
  id: string;
  message: string;
  placeQuery: string;
  radiusMeters: number;
  requestedAt: string;
  sourceAgentPath: string;
};

export type LocationReminder = LocationReminderDetails &
  (
    | { status: "requested" }
    | { regionCount: number; status: "armed" }
    | { reason: string; status: "failed" }
  );

export type Coordinates = { latitude: number; longitude: number };

export type ReminderPlace = Coordinates & { id: string; name: string };

export type ReminderRegion = Coordinates & {
  identifier: string;
  notifyOnEnter: true;
  notifyOnExit: false;
  radius: number;
};

export type AllocatedReminderRegion = {
  region: ReminderRegion;
  reminder: LocationReminder;
};

export function reduceLocationReminders(events: LocationReminderStreamEvent[]): LocationReminder[] {
  const active = new Map<string, LocationReminder>();
  for (const event of events) {
    if (event.type === LOCATION_REMINDER_EVENT.requested) {
      const id = requireString(event.payload, "id", "location reminder");
      active.set(id, {
        id,
        message: requireString(event.payload, "message", `location reminder "${id}"`),
        placeQuery: requireString(event.payload, "placeQuery", `location reminder "${id}"`),
        radiusMeters: requireRadius(event.payload, id),
        requestedAt: event.createdAt,
        sourceAgentPath: requireString(
          event.payload,
          "sourceAgentPath",
          `location reminder "${id}"`,
        ),
        status: "requested",
      });
    }
    if (event.type === LOCATION_REMINDER_EVENT.cancelled) {
      active.delete(requireString(event.payload, "id", "location reminder cancellation"));
    }
    if (event.type === LOCATION_REMINDER_EVENT.delivered) {
      const id = requireString(event.payload, "id", "location reminder delivery");
      requireString(event.payload, "regionIdentifier", `location reminder "${id}" delivery`);
      active.delete(id);
    }
    if (event.type === LOCATION_REMINDER_EVENT.armed) {
      const id = requireString(event.payload, "id", "armed location reminder");
      const reminder = active.get(id);
      if (reminder === undefined) {
        throw new Error(`location reminder "${id}" was armed before it was requested`);
      }
      active.set(id, {
        ...reminder,
        regionCount: requireRegionCount(event.payload, id),
        status: "armed",
      });
    }
    if (event.type === LOCATION_REMINDER_EVENT.armingFailed) {
      const id = requireString(event.payload, "id", "failed location reminder");
      const reminder = active.get(id);
      if (reminder === undefined) {
        throw new Error(`location reminder "${id}" failed before it was requested`);
      }
      active.set(id, {
        ...reminder,
        reason: requireString(event.payload, "reason", `location reminder "${id}"`),
        status: "failed",
      });
    }
  }
  return [...active.values()];
}

export function selectReminderRegions(input: {
  limit: number;
  origin: Coordinates;
  places: ReminderPlace[];
  reminder: LocationReminder;
}): ReminderRegion[] {
  return [...input.places]
    .sort((left, right) => distanceMeters(input.origin, left) - distanceMeters(input.origin, right))
    .slice(0, input.limit)
    .map((place) => ({
      identifier: `location-reminder:${input.reminder.id}:${place.id}`,
      latitude: place.latitude,
      longitude: place.longitude,
      notifyOnEnter: true,
      notifyOnExit: false,
      radius: input.reminder.radiusMeters,
    }));
}

export function allocateReminderRegions(input: {
  limit: number;
  origin: Coordinates;
  searches: Array<{ places: ReminderPlace[]; reminder: LocationReminder }>;
}): AllocatedReminderRegion[] {
  const perReminder = input.searches.map(({ places, reminder }) => ({
    reminder,
    regions: selectReminderRegions({ limit: input.limit, origin: input.origin, places, reminder }),
  }));
  const allocated: AllocatedReminderRegion[] = [];
  for (let placeIndex = 0; allocated.length < input.limit; placeIndex += 1) {
    let added = false;
    for (const result of perReminder) {
      const region = result.regions[placeIndex];
      if (region === undefined || allocated.length === input.limit) continue;
      allocated.push({ region, reminder: result.reminder });
      added = true;
    }
    if (!added) break;
  }
  return allocated;
}

function distanceMeters(left: Coordinates, right: Coordinates): number {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left.latitude)) *
      Math.cos(radians(right.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function requireString(payload: Record<string, unknown>, field: string, subject: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${subject} has an invalid ${field}`);
  }
  return value;
}

function requireRadius(payload: Record<string, unknown>, id: string): number {
  const radius = payload.radiusMeters;
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
    throw new Error(`location reminder "${id}" has an invalid radiusMeters`);
  }
  return radius;
}

function requireRegionCount(payload: Record<string, unknown>, id: string): number {
  const count = payload.regionCount;
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
    throw new Error(`location reminder "${id}" has an invalid regionCount`);
  }
  return count;
}
