import { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vitest";
import { withInitialize as publicWithInitialize } from "@iterate-com/shared/durable-object-utils/mixins/initialize";
import { withExternalListing } from "./external-listing.ts";
import { withKvInspector } from "./kv-inspector.ts";
import { withOuterbase } from "./outerbase.ts";
import type { InitializeInput } from "./initialize.ts";
import { getInitializedDoStub, withInitialize } from "./initialize.ts";

type Env = {
  EXAMPLE: string;
};

type EnvWithListings = Env & {
  DO_LISTINGS: D1Database;
};

type RoomInit = {
  name: string;
  ownerUserId: string;
};

const RoomBase = withInitialize<RoomInit>()(DurableObject);

class Room extends RoomBase<Env> {
  sendMessage(text: string) {
    const init = this.initParams;

    expectTypeOf(init).toEqualTypeOf<RoomInit>();

    return {
      room: init.name,
      ownerUserId: init.ownerUserId,
      text,
    };
  }
}

declare const ctx: DurableObjectState;
declare const env: Env;
declare const namespace: DurableObjectNamespace<Room>;

const room = new Room(ctx, env);

expectTypeOf(room.initialize).toBeFunction();
expectTypeOf(room.assertInitialized()).toEqualTypeOf<RoomInit>();
expectTypeOf(room.sendMessage("hello")).toEqualTypeOf<{
  room: string;
  ownerUserId: string;
  text: string;
}>();
expectTypeOf(
  getInitializedDoStub({
    namespace,
    name: "room-a",
    initParams: {
      ownerUserId: "user-a",
    },
  }),
).resolves.toEqualTypeOf<DurableObjectStub<Room>>();

// @ts-expect-error Room initialization needs ownerUserId, so the helper must receive initParams.
getInitializedDoStub({
  namespace,
  name: "room-a",
});

type NameOnlyInit = {
  name: string;
};

const NameOnlyRoomBase = withInitialize<NameOnlyInit>()(DurableObject);

class NameOnlyRoom extends NameOnlyRoomBase<Env> {}

declare const nameOnlyNamespace: DurableObjectNamespace<NameOnlyRoom>;

expectTypeOf(
  getInitializedDoStub({
    namespace: nameOnlyNamespace,
    name: "name-only-room",
  }),
).resolves.toEqualTypeOf<DurableObjectStub<NameOnlyRoom>>();

const withoutName = {
  ownerUserId: "user-a",
} satisfies InitializeInput<RoomInit>;

const withMatchingName = {
  name: "room-a",
  ownerUserId: "user-a",
} satisfies InitializeInput<RoomInit>;

void withoutName;
void withMatchingName;

// @ts-expect-error initParams is protected and must not be part of the public API.
room.initParams;

class RootWithStatic<RootEnv> extends DurableObject<RootEnv> {
  static rootStatic() {
    return "root-static";
  }
}

const StaticRoomBase = withInitialize<RoomInit>()(RootWithStatic);

class StaticRoom extends StaticRoomBase<Env> {}

expectTypeOf(StaticRoom.rootStatic()).toEqualTypeOf<string>();
expectTypeOf(new StaticRoom(ctx, env).assertInitialized()).toEqualTypeOf<RoomInit>();

class NotDurableObject {}

// @ts-expect-error mixins require a DurableObject base class because they use this.ctx.
withInitialize<RoomInit>()(NotDurableObject);

// @ts-expect-error inspector mixins require a DurableObject base class because they use this.ctx.
withOuterbase({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL" })(NotDurableObject);

// @ts-expect-error inspector mixins require a DurableObject base class because they use this.ctx.
withKvInspector({ unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV" })(NotDurableObject);

const PublicRoomBase = publicWithInitialize<RoomInit>()(DurableObject);

class PublicRoom extends PublicRoomBase<Env> {}

expectTypeOf(new PublicRoom(ctx, env).assertInitialized()).toEqualTypeOf<RoomInit>();

const ListedRoomBase = withExternalListing<RoomInit, EnvWithListings>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(RoomBase);

class ListedRoom extends ListedRoomBase<EnvWithListings> {}

expectTypeOf(new ListedRoom(ctx, env as EnvWithListings).getExternalListing).toBeFunction();

// @ts-expect-error the final Env must satisfy the Env lower-bound used by getDatabase(env).
void class extends ListedRoomBase<Env> {};
