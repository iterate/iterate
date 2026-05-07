import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { withAppConfig as publicWithAppConfig } from "@iterate-com/shared/durable-object-utils/mixins/with-app-config";
import { BaseAppConfig, redacted } from "../../apps/config.ts";
import { withDurableObjectCore } from "./with-durable-object-core.ts";
import { withLifecycleHooks } from "./with-lifecycle-hooks.ts";
import { withAppConfig } from "./with-app-config.ts";

const AppConfig = BaseAppConfig.extend({
  apiBaseUrl: z.string().trim().min(1),
  token: redacted(z.string().trim().min(1)),
  feature: z.object({
    enabled: z.boolean(),
  }),
});

type AppConfig = z.output<typeof AppConfig>;

type Env = {
  APP_CONFIG: string;
  OTHER_BINDING: Fetcher;
};

const AppConfigBase = withAppConfig(AppConfig)(DurableObject);

class AppConfigRoom extends AppConfigBase<Env> {
  readConfig() {
    const config = this.config;

    expectTypeOf(config).toEqualTypeOf<AppConfig>();

    return {
      apiBaseUrl: config.apiBaseUrl,
      enabled: config.feature.enabled,
      token: config.token,
    };
  }
}

describe("withAppConfig types", () => {
  it("adds protected typed config while preserving Base<Env>", () => {
    const room = {} as AppConfigRoom;

    expectTypeOf(room.readConfig()).toEqualTypeOf<{
      apiBaseUrl: string;
      enabled: boolean;
      token: AppConfig["token"];
    }>();

    // @ts-expect-error config is protected and must not be part of the public Durable Object API.
    room.config;
  });

  it("preserves static members from the wrapped base class", () => {
    class RootWithStatic<RootEnv> extends DurableObject<RootEnv> {
      static rootStatic() {
        return "root-static";
      }
    }

    const StaticBase = withAppConfig(AppConfig)(RootWithStatic);

    class StaticRoom extends StaticBase<Env> {}

    expectTypeOf(StaticRoom.rootStatic()).toEqualTypeOf<string>();
  });

  it("preserves members from lower mixins", () => {
    type RoomInit = {
      ownerUserId: string;
    };

    const RoomInit = z.object({
      ownerUserId: z.string(),
    });

    const Base = withAppConfig(AppConfig)(
      withLifecycleHooks({ nameSchema: RoomInit })(withDurableObjectCore(DurableObject)),
    );

    class Room extends Base<Env> {
      readBoth() {
        return {
          ownerUserId: this.structuredName.ownerUserId,
          apiBaseUrl: this.config.apiBaseUrl,
        };
      }
    }

    const room = {} as Room;

    expectTypeOf(room.assertInitialized()).toEqualTypeOf<RoomInit>();
    expectTypeOf(room.readBoth()).toEqualTypeOf<{
      ownerUserId: string;
      apiBaseUrl: string;
    }>();
  });

  it("works through the package export path", () => {
    const PublicBase = publicWithAppConfig(AppConfig)(DurableObject);

    class PublicRoom extends PublicBase<Env> {
      readBaseUrl() {
        return this.config.baseUrl;
      }
    }

    const room = {} as PublicRoom;

    expectTypeOf(room.readBaseUrl()).toEqualTypeOf<string | undefined>();
  });
});
