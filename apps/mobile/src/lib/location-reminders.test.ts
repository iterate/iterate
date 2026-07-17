import { expect, test } from "vitest";
import {
  LOCATION_REMINDER_EVENT,
  allocateReminderRegions,
  reduceLocationReminders,
  selectReminderRegions,
  type LocationReminderStreamEvent,
} from "./location-reminders.ts";

test("a requested location reminder is active until it is resolved", () => {
  const reminders = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
  ]);

  expect(reminders).toEqual([
    {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      requestedAt: "2026-07-17T12:00:01.000Z",
      sourceAgentPath: "/agents/mobile/groceries",
      status: "requested",
    },
  ]);
});

test("a cancelled reminder is no longer active", () => {
  const reminders = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
    event(2, LOCATION_REMINDER_EVENT.cancelled, { id: "buy-milk" }),
  ]);

  expect(reminders).toEqual([]);
});

test("a semantic place reminder arms the nearest places with stable region identifiers", () => {
  const [reminder] = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
  ]);

  const regions = selectReminderRegions({
    limit: 2,
    origin: { latitude: 51.5072, longitude: -0.1276 },
    places: [
      { id: "far-store", latitude: 51.54, longitude: -0.18, name: "Far Supermarket" },
      { id: "near-store", latitude: 51.508, longitude: -0.128, name: "Near Supermarket" },
      { id: "middle-store", latitude: 51.515, longitude: -0.14, name: "Middle Supermarket" },
    ],
    reminder,
  });

  expect(regions).toEqual([
    {
      identifier: "location-reminder:buy-milk:near-store",
      latitude: 51.508,
      longitude: -0.128,
      notifyOnEnter: true,
      notifyOnExit: false,
      radius: 250,
    },
    {
      identifier: "location-reminder:buy-milk:middle-store",
      latitude: 51.515,
      longitude: -0.14,
      notifyOnEnter: true,
      notifyOnExit: false,
      radius: 250,
    },
  ]);
});

test("a malformed reminder event fails visibly instead of arming corrupt state", () => {
  expect(() =>
    reduceLocationReminders([
      event(1, LOCATION_REMINDER_EVENT.requested, {
        id: "buy-milk",
        message: "Buy milk",
        placeQuery: "supermarket",
        radiusMeters: "nearby",
        sourceAgentPath: "/agents/mobile/groceries",
      }),
    ]),
  ).toThrow('location reminder "buy-milk" has an invalid radiusMeters');
});

test("an armed event exposes how many concrete places the phone is monitoring", () => {
  const reminders = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
    event(2, LOCATION_REMINDER_EVENT.armed, { id: "buy-milk", regionCount: 8 }),
  ]);

  expect(reminders).toMatchObject([{ id: "buy-milk", regionCount: 8, status: "armed" }]);
});

test("a delivered one-shot reminder is no longer active", () => {
  const reminders = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
    event(2, LOCATION_REMINDER_EVENT.delivered, {
      id: "buy-milk",
      regionIdentifier: "location-reminder:buy-milk:near-store",
    }),
  ]);

  expect(reminders).toEqual([]);
});

test("a failed arming attempt remains visible and retryable", () => {
  const reminders = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
    event(2, LOCATION_REMINDER_EVENT.armingFailed, {
      id: "buy-milk",
      reason: "No nearby places found",
    }),
  ]);

  expect(reminders).toMatchObject([
    { id: "buy-milk", reason: "No nearby places found", status: "failed" },
  ]);
});

test("the iOS region budget is shared across active reminders", () => {
  const [milk, parcel] = reduceLocationReminders([
    event(1, LOCATION_REMINDER_EVENT.requested, {
      id: "buy-milk",
      message: "Buy milk",
      placeQuery: "supermarket",
      radiusMeters: 250,
      sourceAgentPath: "/agents/mobile/groceries",
    }),
    event(2, LOCATION_REMINDER_EVENT.requested, {
      id: "post-parcel",
      message: "Post parcel",
      placeQuery: "post office",
      radiusMeters: 150,
      sourceAgentPath: "/agents/mobile/errands",
    }),
  ]);

  const allocated = allocateReminderRegions({
    limit: 2,
    origin: { latitude: 51.5072, longitude: -0.1276 },
    searches: [
      {
        places: [
          { id: "store-1", latitude: 51.508, longitude: -0.128, name: "Store 1" },
          { id: "store-2", latitude: 51.51, longitude: -0.13, name: "Store 2" },
        ],
        reminder: milk,
      },
      {
        places: [
          { id: "post-1", latitude: 51.509, longitude: -0.129, name: "Post office 1" },
          { id: "post-2", latitude: 51.511, longitude: -0.131, name: "Post office 2" },
        ],
        reminder: parcel,
      },
    ],
  });

  expect(allocated.map((item) => item.reminder.id)).toEqual(["buy-milk", "post-parcel"]);
});

function event(
  offset: number,
  type: string,
  payload: Record<string, unknown>,
): LocationReminderStreamEvent {
  return {
    createdAt: `2026-07-17T12:00:0${offset}.000Z`,
    offset,
    payload,
    type,
  };
}
