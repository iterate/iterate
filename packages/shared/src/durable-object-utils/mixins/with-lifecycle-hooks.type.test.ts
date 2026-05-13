import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { withDurableObjectCore as publicWithDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withLifecycleHooks as publicWithLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import type { D1ObjectCatalogRecord } from "./with-lifecycle-hooks.ts";
import { withDurableObjectCore } from "./with-durable-object-core.ts";
import { withKvInspector } from "./with-kv-inspector.ts";
import { withMultiplexedAlarms } from "./with-multiplexed-alarms.ts";
import type { MultiplexedAlarmRecord } from "./with-multiplexed-alarms.ts";
import { withOuterbase } from "./with-outerbase.ts";
import {
  registerDurableObjectPublicRoute,
  withPublicFetchRoute,
} from "./with-public-fetch-route.ts";
import { withScheduler } from "./with-scheduler.ts";
import type { SchedulerRecord } from "./with-scheduler.ts";
import { getInitializedDoStub, withLifecycleHooks } from "./with-lifecycle-hooks.ts";

type Env = {
  EXAMPLE: string;
};

type ListingEnv = {
  DO_CATALOG: D1Database;
};

type EnvWithListings = Env & ListingEnv;

type RoomInit = {
  ownerUserId: string;
};

const RoomInit = z.object({
  ownerUserId: z.string(),
});

type RoomInitialState = {
  projectId: string;
  plan: "free" | "pro";
};

const RoomInitialState = z.object({
  projectId: z.string(),
  plan: z.enum(["free", "pro"]),
});

const DurableObjectCore = withDurableObjectCore(DurableObject);

// The normal incantation: build a generic base once, then extend it as
// `RoomBase<Env>`.
const RoomBase = withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(
  DurableObjectCore,
);

class Room extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Subclasses and later mixins can register first-initialize work that runs
    // after initialize() creates typed params for the first time.
    this.registerOnFirstInitialize((params) => {
      expectTypeOf(params).toEqualTypeOf<RoomInit>();
    });

    // They can also register per-instance wake work. This is where future
    // alarm/scheduler mixins rehydrate state after params exist.
    this.registerOnInstanceWake((params) => {
      expectTypeOf(params).toEqualTypeOf<RoomInit>();
    });
  }

  sendMessage(text: string) {
    // Subclasses get typed protected params without plumbing init state through
    // every method signature.
    const init = this.structuredName;

    expectTypeOf(init).toEqualTypeOf<RoomInit>();

    return {
      room: this.name,
      ownerUserId: init.ownerUserId,
      text,
    };
  }
}

const room = {} as Room;
const namespace = {} as DurableObjectNamespace<Room>;

const InitialStateRoomBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  initialStateSchema: RoomInitialState,
})(DurableObjectCore);

class InitialStateRoom extends InitialStateRoomBase<Env> {
  describeInitialState() {
    expectTypeOf(this.structuredName).toEqualTypeOf<string>();
    expectTypeOf(this.initialState).toEqualTypeOf<RoomInitialState>();

    return `${this.name}:${this.initialState.projectId}:${this.initialState.plan}`;
  }
}

const initialStateNamespace = {} as DurableObjectNamespace<InitialStateRoom>;

describe("withLifecycleHooks types", () => {
  it("adds public initialize/assertInitialized members and protected subclass params", () => {
    expectTypeOf(room.initialize).toBeFunction();
    expectTypeOf(
      room.initialize({
        name: '{"ownerUserId":"user-a"}',
      }),
    ).resolves.toEqualTypeOf<RoomInit>();
    expectTypeOf(room.assertInitialized()).toEqualTypeOf<RoomInit>();
    expectTypeOf(room.ensureStarted()).resolves.toEqualTypeOf<RoomInit>();
    expectTypeOf(room.sendMessage("hello")).toEqualTypeOf<{
      room: string;
      ownerUserId: string;
      text: string;
    }>();

    // This is the main protected-member payoff: subclasses can use
    // `this.structuredName`, but consumers of a stub/class instance cannot reach it.
    // @ts-expect-error structuredName is protected and must not be part of the public API.
    room.structuredName;

    // @ts-expect-error registerOnFirstInitialize is for subclasses/mixins, not external callers.
    room.registerOnFirstInitialize;

    // @ts-expect-error registerOnInstanceWake is for subclasses/mixins, not external callers.
    room.registerOnInstanceWake;
  });

  it("accepts either string names or structured names", () => {
    expectTypeOf(
      getInitializedDoStub({
        allowCreate: true,
        namespace,
        name: {
          ownerUserId: "user-a",
        },
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<Room>>();

    expectTypeOf(
      getInitializedDoStub({
        allowCreate: true,
        namespace,
        name: "room-a",
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<Room>>();

    expectTypeOf(
      getInitializedDoStub({
        allowCreate: false,
        namespace,
        name: "room-a",
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<Room> | null>();

    getInitializedDoStub({
      allowCreate: true,
      namespace,
      // @ts-expect-error ownerUserId is required when structuredName is used for Room.
      name: {},
    });
  });

  it("defaults to string names when no structured-name type argument is provided", () => {
    const NameOnlyRoomBase = withLifecycleHooks({ d1ObjectCatalog: "none" })(DurableObjectCore);

    class NameOnlyRoom extends NameOnlyRoomBase<Env> {}

    const nameOnlyNamespace = {} as DurableObjectNamespace<NameOnlyRoom>;

    // NameOnlyInit has no fields beyond name, so the stub name is enough.
    expectTypeOf(
      getInitializedDoStub({
        allowCreate: true,
        namespace: nameOnlyNamespace,
        name: "name-only-room",
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<NameOnlyRoom>>();

    expectTypeOf(
      nameOnlyNamespace.getByName("name-only-room").initialize({
        name: "name-only-room",
      }),
    ).resolves.toEqualTypeOf<string>();
  });

  it("types immutable initial state separately from structured names", () => {
    expectTypeOf(
      getInitializedDoStub({
        allowCreate: true,
        namespace: initialStateNamespace,
        name: "stateful-room",
        initialState: {
          projectId: "project-a",
          plan: "pro",
        },
      }),
    ).resolves.toEqualTypeOf<DurableObjectStub<InitialStateRoom>>();

    // @ts-expect-error initialState is required when allowCreate can initialize a stateful DO.
    getInitializedDoStub({
      allowCreate: true,
      namespace: initialStateNamespace,
      name: "stateful-room",
    });

    getInitializedDoStub({
      allowCreate: true,
      namespace: initialStateNamespace,
      name: "stateful-room",
      // @ts-expect-error projectId is required by the initial state schema.
      initialState: {
        plan: "pro",
      },
    });

    getInitializedDoStub({
      allowCreate: true,
      namespace: initialStateNamespace,
      name: "stateful-room",
      initialState: {
        projectId: "project-a",
        // @ts-expect-error initialState must use the configured plan enum.
        plan: "enterprise",
      },
    });

    expectTypeOf(
      initialStateNamespace.getByName("stateful-room").initialize({
        name: "stateful-room",
        initialState: {
          projectId: "project-a",
          plan: "free",
        },
      }),
    ).resolves.toEqualTypeOf<string>();

    expectTypeOf(
      initialStateNamespace.getByName("stateful-room").initialize({
        name: "stateful-room",
      }),
    ).resolves.toEqualTypeOf<string>();
  });

  it("preserves static members from the wrapped base class", () => {
    class RootWithStatic<RootEnv> extends DurableObject<RootEnv> {
      static rootStatic() {
        return "root-static";
      }
    }

    const StaticRoomBase = withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(
      withDurableObjectCore(RootWithStatic),
    );

    class StaticRoom extends StaticRoomBase<Env> {}

    const staticRoom = {} as StaticRoom;

    expectTypeOf(StaticRoom.rootStatic()).toEqualTypeOf<string>();
    expectTypeOf(staticRoom.assertInitialized()).toEqualTypeOf<RoomInit>();
  });

  it("rejects non-DurableObject bases", () => {
    class NotDurableObject {}

    // @ts-expect-error lifecycle hooks require the core Durable Object adapter below them.
    withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(NotDurableObject);

    // @ts-expect-error lifecycle hooks require withDurableObjectCore below them.
    withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(DurableObject);

    // @ts-expect-error inspector mixins require the core Durable Object adapter below them.
    withOuterbase({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL" })(NotDurableObject);

    // @ts-expect-error inspector mixins require the core Durable Object adapter below them.
    withKvInspector({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV" })(NotDurableObject);
  });

  it("works through the package export path", () => {
    const PublicRoomBase = publicWithLifecycleHooks({
      d1ObjectCatalog: "none",
      nameSchema: RoomInit,
    })(publicWithDurableObjectCore(DurableObject));

    class PublicRoom extends PublicRoomBase<Env> {}

    const publicRoom = {} as PublicRoom;

    expectTypeOf(publicRoom.assertInitialized()).toEqualTypeOf<RoomInit>();
  });
});

describe("withLifecycleHooks D1 object catalog types", () => {
  it("keeps the D1 env lower-bound on the composed class", () => {
    // The second generic is the minimum env shape getDatabase needs, not
    // necessarily the final Worker Env.
    const ListedRoomBase = withLifecycleHooks<RoomInit, undefined, ListingEnv>({
      d1ObjectCatalog: {
        className: "Room",
        getDatabase(env) {
          return env.DO_CATALOG;
        },
        indexes: {
          ownerUserId(params) {
            return params.ownerUserId;
          },
        },
      },
      nameSchema: RoomInit,
    })(DurableObjectCore);

    class ListedRoom extends ListedRoomBase<EnvWithListings> {
      getOwnerUserId() {
        // D1 cataloging must not erase withLifecycleHooks' protected subclass
        // surface.
        return this.structuredName.ownerUserId;
      }
    }

    const listedRoom = {} as ListedRoom;

    expectTypeOf(listedRoom.getD1ObjectCatalogRecord).toBeFunction();
    expectTypeOf(
      listedRoom.getD1ObjectCatalogRecord(),
    ).resolves.toEqualTypeOf<D1ObjectCatalogRecord<RoomInit> | null>();
    expectTypeOf(listedRoom.getOwnerUserId()).toEqualTypeOf<string>();

    // This is the env lower-bound payoff: the mixin only needs DO_CATALOG, but
    // every final Env used with the composed class must still include it.
    // @ts-expect-error ListedRoomBase requires an Env with DO_CATALOG because getDatabase reads env.DO_CATALOG.
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
          payload: { room: this.name },
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
          payload: { room: this.name },
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
      })(DurableObjectCore),
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

describe("public fetch route mixin types", () => {
  it("adds an instance path helper and preserves the generic Durable Object base shape", () => {
    const PublicRouteRoomBase = withPublicFetchRoute({
      namespaceSlug: "rooms",
      defaultAddressing: "by-structured-name",
    })(RoomBase);

    class PublicRouteRoom extends PublicRouteRoomBase<Env> {}

    const publicRouteRoom = {} as PublicRouteRoom;
    const publicRouteNamespace = {} as DurableObjectNamespace<PublicRouteRoom>;

    expectTypeOf(publicRouteRoom.getPublicDurableObjectPath()).toEqualTypeOf<string>();
    expectTypeOf(
      publicRouteRoom.getPublicDurableObjectPath({ mode: "by-id" }),
    ).toEqualTypeOf<string>();
    const registration = registerDurableObjectPublicRoute({
      namespace: publicRouteNamespace,
      class: PublicRouteRoom,
    });

    expectTypeOf(registration.namespaceSlug).toEqualTypeOf<string>();
  });
});
