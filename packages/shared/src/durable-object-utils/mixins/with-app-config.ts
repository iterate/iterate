/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";
import { parseAppConfigFromEnv } from "../../apps/config.ts";
import type {
  Constructor,
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";

const APP_CONFIG_ENV_PREFIX = "APP_CONFIG_";

type CloudflareEnvObject = Record<string, unknown>;

/**
 * Type-only protected surface for app runtime config.
 *
 * The real protected getter is installed by `withAppConfig()` below. Keeping
 * config protected matters because app config can include redacted secrets and
 * internal URLs; Durable Object public members can become remotely callable.
 */
export abstract class AppConfigProtected<TConfig> {
  protected get config(): TConfig {
    throw new Error("AppConfigProtected is type-only and should never run.");
  }
}

type WithAppConfigResult<TBase extends DurableObjectClass, TSchema extends z.ZodTypeAny> =
  // Preserve the generic Durable Object constructor so this remains legal:
  //
  //   const Base = withAppConfig(AppConfig)(DurableObject);
  //   class Room extends Base<Env> {}
  //
  // `ReqEnvOf<TBase>` keeps env requirements from earlier mixins, and
  // `MembersOf<TBase>` keeps their instance surface available after this mixin.
  StaticSide<TBase> &
    DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & AppConfigProtected<z.output<TSchema>>> &
    Constructor<AppConfigProtected<z.output<TSchema>>>;

/**
 * Adds protected typed app config to a Durable Object.
 *
 * Protected subclass/mixin surface: `this.config`.
 *
 * Config is parsed from the Cloudflare env using the app runtime convention:
 * `APP_CONFIG` provides the base JSON object and `APP_CONFIG_*` variables
 * override nested fields. Parsing delegates to the shared app config parser, so
 * unknown override keys and schema validation failures throw during the first
 * `this.config` access for each Durable Object wake.
 *
 * The parsed object is cached only in memory for the current wake. Durable
 * state still belongs in Durable Object storage; this helper is for runtime
 * env/config access.
 */
export function withAppConfig<TSchema extends z.ZodTypeAny>(configSchema: TSchema) {
  return function <TBase extends DurableObjectClass>(
    Base: TBase,
  ): WithAppConfigResult<TBase, TSchema> {
    const BaseWithDurableObject = Base as unknown as RuntimeDurableObjectConstructor;

    abstract class AppConfigMixin extends BaseWithDurableObject {
      #appConfig: z.output<TSchema> | undefined;

      protected get config(): z.output<TSchema> {
        this.#appConfig ??= parseAppConfigFromEnv({
          configSchema,
          prefix: APP_CONFIG_ENV_PREFIX,
          // Cloudflare envs are object bags of bindings and vars. The config
          // parser ignores non-string values, so service bindings remain safe to
          // pass through here.
          env: this.env as CloudflareEnvObject,
        });

        return this.#appConfig;
      }
    }

    // TypeScript cannot infer that a class-expression wrapper preserves the
    // generic `Base<Env>` constructor while adding a protected getter. The
    // result type above publishes that composed shape and keeps config off the
    // public Durable Object RPC surface.
    return AppConfigMixin as unknown as WithAppConfigResult<TBase, TSchema>;
  };
}
