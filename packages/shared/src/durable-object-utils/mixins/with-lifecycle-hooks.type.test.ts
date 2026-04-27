import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import { withLifecycleHooks as publicWithLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withExternalListing } from "./with-external-listing.ts";
import type { ExternalListingRecord } from "./with-external-listing.ts";
import { withKvInspector } from "./with-kv-inspector.ts";
import { withMultiplexedAlarms } from "./with-multiplexed-alarms.ts";
import type { MultiplexedAlarmRecord } from "./with-multiplexed-alarms.ts";
import { withOuterbase } from "./with-outerbase.ts";
import { withScheduler } from "./with-scheduler.ts";
import type { SchedulerRecord } from "./with-scheduler.ts";
import type { LifecycleInitInput } from "./with-lifecycle-hooks.ts";
import { getOrInitializeDoStub, withLifecycleHooks } from "./with-lifecycle-hooks.ts";

type Env = {
  EXAMPLE: string;
};

type ListingEnv = {
  DO_LISTINGS: D1Database;
};

type EnvWithListings = Env & ListingEnv;

type RoomInit = {
  name: string;
  ownerUserId: string;
};

// The normal incantation: build a generic base once, then extend it as
// `RoomBase<Env>`.
const RoomBase = withLifecycleHooks<RoomInit>()(DurableObject);

class Room extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Subclasses and later mixins can register first-initialize work that runs
    // after initialize() creates typed params for the first time.
    this.registerOnFirstInitialize((params) => {
      expectTypeOf(params).toEqualTypeOf<RoomInit>();
    });

    // They can also register per-activation start work. This is where future
    // alarm/scheduler mixins rehydrate state after params exist.
    this.registerOnStart((params) => {
      expectTypeOf(params).toEqualTypeOf<RoomInit>();
    });
  }

  sendMessage(text: string) {
    // Subclasses get typed protected params without plumbing init state through
    // every method signature.
    const init = this.initParams;

    expectTypeOf(init).toEqualTypeOf<RoomInit>();

    return {
      room: init.name,
      ownerUserId: init.ownerUserId,
      text,
    };
  }
}

const room = {} as Room;
const namespace = {} as DurableObjectNamespace<Room>;

describe("withLifecycleHooks types", () => {
  it("adds public initialize/assertInitialized members and protected subclass params", () => {
    expectTypeOf(room.initialize).toBeFunction();
    expectTypeOf(room.assertInitialized()).toEqualTypeOf<RoomInit>();
    expectTypeOf(room.ensureStarted()).resolves.toEqualTypeOf<RoomInit>();
    expectTypeOf(room.sendMessage("hello")).toEqualTypeOf<{
      room: string;
      ownerUserId: string;
      text: string;
    }>();

    // This is the main protected-member payoff: subclasses can use
    // `this.initParams`, but consumers of a stub/class instance cannot reach it.
    // @ts-expect-error initParams is protected and must not be part of the public API.
    room.initParams;

    // @ts-expect-error registerOnFirstInitialize is for subclasses/mixins, not external callers.
    room.registerOnFirstInitialize;

    // @ts-expect-error registerOnStart is for subclasses/mixins, not external callers.
    room.registerOnStart;
  });

  it("requires initParams when the init shape has fields beyond name", () => {
    // RoomInit has ownerUserId, so initParams is required.
    expectTypeOf(
      getOrInitializeDoStub({
        namespace,
        name: "room-a",
        initParams: {
          ownerUserId: "user-a",
        },
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<Room>>();

    // @ts-expect-error Room initialization needs ownerUserId, so the helper must receive initParams.
    getOrInitializeDoStub({
      namespace,
      name: "room-a",
    });
  });

  it("allows omitted initParams when name is the whole init shape", () => {
    type NameOnlyInit = {
      name: string;
    };

    const NameOnlyRoomBase = withLifecycleHooks<NameOnlyInit>()(DurableObject);

    class NameOnlyRoom extends NameOnlyRoomBase<Env> {}

    const nameOnlyNamespace = {} as DurableObjectNamespace<NameOnlyRoom>;

    // NameOnlyInit has no fields beyond name, so the stub name is enough.
    expectTypeOf(
      getOrInitializeDoStub({
        namespace: nameOnlyNamespace,
        name: "name-only-room",
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<NameOnlyRoom>>();
  });

  it("keeps LifecycleInitInput explicit while letting getOrInitializeDoStub fill in name", () => {
    const withoutName = {
      ownerUserId: "user-a",
    } satisfies LifecycleInitInput<RoomInit>;

    const withMatchingName = {
      name: "room-a",
      ownerUserId: "user-a",
    } satisfies LifecycleInitInput<RoomInit>;

    expectTypeOf(withoutName).toEqualTypeOf<{ ownerUserId: string }>();
    expectTypeOf(withMatchingName).toEqualTypeOf<{
      name: string;
      ownerUserId: string;
    }>();

    // @ts-expect-error ownerUserId is required for RoomInit.
    void ({} satisfies LifecycleInitInput<RoomInit>);
  });

  it("preserves discriminated union init shapes when name is filled by the helper", () => {
    type UnionInit =
      | {
          name: string;
          kind: "team";
          teamId: string;
        }
      | {
          name: string;
          kind: "user";
          userId: string;
        };

    const team = {
      kind: "team",
      teamId: "team-a",
    } satisfies LifecycleInitInput<UnionInit>;

    const user = {
      kind: "user",
      userId: "user-a",
    } satisfies LifecycleInitInput<UnionInit>;

    expectTypeOf(team).toEqualTypeOf<{
      kind: "team";
      teamId: string;
    }>();
    expectTypeOf(user).toEqualTypeOf<{
      kind: "user";
      userId: string;
    }>();

    // @ts-expect-error userId belongs to the user variant, not the team variant.
    void ({ kind: "team", userId: "user-a" } satisfies LifecycleInitInput<UnionInit>);
  });

  it("preserves static members from the wrapped base class", () => {
    class RootWithStatic<RootEnv> extends DurableObject<RootEnv> {
      static rootStatic() {
        return "root-static";
      }
    }

    const StaticRoomBase = withLifecycleHooks<RoomInit>()(RootWithStatic);

    class StaticRoom extends StaticRoomBase<Env> {}

    const staticRoom = {} as StaticRoom;

    expectTypeOf(StaticRoom.rootStatic()).toEqualTypeOf<string>();
    expectTypeOf(staticRoom.assertInitialized()).toEqualTypeOf<RoomInit>();
  });

  it("rejects non-DurableObject bases", () => {
    class NotDurableObject {}

    // @ts-expect-error mixins require a DurableObject base class because they use this.ctx.
    withLifecycleHooks<RoomInit>()(NotDurableObject);

    // @ts-expect-error inspector mixins require a DurableObject base class because they use this.ctx.
    withOuterbase({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL" })(NotDurableObject);

    // @ts-expect-error inspector mixins require a DurableObject base class because they use this.ctx.
    withKvInspector({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV" })(NotDurableObject);
  });

  it("works through the package export path", () => {
    const PublicRoomBase = publicWithLifecycleHooks<RoomInit>()(DurableObject);

    class PublicRoom extends PublicRoomBase<Env> {}

    const publicRoom = {} as PublicRoom;

    expectTypeOf(publicRoom.assertInitialized()).toEqualTypeOf<RoomInit>();
  });
});

describe("withExternalListing types", () => {
  it("keeps the D1 env lower-bound on the composed class", () => {
    // The second generic is the minimum env shape getDatabase needs, not
    // necessarily the final Worker Env.
    const ListedRoomBase = withExternalListing<RoomInit, ListingEnv>({
      className: "Room",
      getDatabase(env) {
        return env.DO_LISTINGS;
      },
    })(RoomBase);

    class ListedRoom extends ListedRoomBase<EnvWithListings> {
      getOwnerUserId() {
        // External listing must not erase withLifecycleHooks' protected subclass
        // surface.
        return this.initParams.ownerUserId;
      }
    }

    const listedRoom = {} as ListedRoom;

    expectTypeOf(listedRoom.getExternalListing).toBeFunction();
    expectTypeOf(
      listedRoom.getExternalListing(),
    ).resolves.toEqualTypeOf<ExternalListingRecord<RoomInit> | null>();
    expectTypeOf(listedRoom.getOwnerUserId()).toEqualTypeOf<string>();

    // This is the env lower-bound payoff: the mixin only needs DO_LISTINGS, but
    // every final Env used with the composed class must still include it.
    // @ts-expect-error ListedRoomBase requires an Env with DO_LISTINGS because getDatabase reads env.DO_LISTINGS.
    void class extends ListedRoomBase<Env> {};
  });
});

describe("withMultiplexedAlarms types", () => {
  it("adds public diagnostic reads and protected scheduling methods", () => {
    const AlarmRoomBase = withMultiplexedAlarms<RoomInit>()(RoomBase);

    class AlarmRoom extends AlarmRoomBase<Env> {
      async scheduleDailySummary() {
        await this.scheduleMultiplexedAlarm({
          key: "daily-summary",
          runAt: Date.now(),
          method: "sendDailySummary",
          payload: { room: this.initParams.name },
        });

        expectTypeOf(await this.cancelMultiplexedAlarm("daily-summary")).toEqualTypeOf<boolean>();
      }

      protected sendDailySummary(payload: unknown) {
        expectTypeOf(payload).toEqualTypeOf<unknown>();
      }
    }

    const alarmRoom = {} as AlarmRoom;

    expectTypeOf(alarmRoom.getMultiplexedAlarms()).toEqualTypeOf<MultiplexedAlarmRecord[]>();

    // Mutation APIs are for subclasses/mixins, not external callers.
    // @ts-expect-error scheduleMultiplexedAlarm is protected.
    alarmRoom.scheduleMultiplexedAlarm;

    // @ts-expect-error cancelMultiplexedAlarm is protected.
    alarmRoom.cancelMultiplexedAlarm;
  });
});

describe("withScheduler types", () => {
  it("adds public diagnostic reads and protected schedule mutation", async () => {
    const ScheduledRoomBase = withScheduler<RoomInit>()(
      withMultiplexedAlarms<RoomInit>()(RoomBase),
    );

    class ScheduledRoom extends ScheduledRoomBase<Env> {
      async enableDailySummary() {
        const schedule = await this.schedule({
          key: "daily-summary",
          method: "sendDailySummary",
          payload: { room: this.initParams.name },
          recurrence: {
            type: "cron",
            expression: "0 9 * * *",
          },
        });

        expectTypeOf(schedule).toEqualTypeOf<SchedulerRecord>();
        expectTypeOf(await this.cancelSchedule("daily-summary")).toEqualTypeOf<boolean>();
      }

      protected sendDailySummary(payload: unknown, schedule: SchedulerRecord) {
        expectTypeOf(payload).toEqualTypeOf<unknown>();
        expectTypeOf(schedule.key).toEqualTypeOf<string>();
      }
    }

    const scheduledRoom = {} as ScheduledRoom;

    expectTypeOf(
      scheduledRoom.getSchedule("daily-summary"),
    ).toEqualTypeOf<SchedulerRecord | null>();
    expectTypeOf(scheduledRoom.getSchedules()).toEqualTypeOf<SchedulerRecord[]>();

    // Mutation APIs are for subclasses/mixins, not external callers.
    // @ts-expect-error schedule is protected.
    scheduledRoom.schedule;

    // @ts-expect-error cancelSchedule is protected.
    scheduledRoom.cancelSchedule;
  });
});

describe("inspector mixin types", () => {
  it("preserves the generic DurableObject base shape through fetch wrappers", () => {
    const InspectorBase = withKvInspector({
      unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
    })(
      withOuterbase({
        unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
      })(DurableObject),
    );

    class Inspector extends InspectorBase<Env> {}

    const inspector = {} as Inspector;

    // Regression test for the generic constructor surface: these debug wrappers
    // do not add env requirements, so the simple withVoice-style `TBase &
    // Constructor<FetchBase>` result is enough. If this stops compiling, a
    // wrapper erased the normal `Base<Env>` Durable Object shape.
    expectTypeOf(inspector.fetch).toBeFunction();
  });
});
