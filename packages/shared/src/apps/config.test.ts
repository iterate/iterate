import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  BaseAppConfig,
  Redacted,
  extractPublicConfigSchema,
  getConfigVisibility,
  getPublicConfig,
  parseAppConfigFromEnv,
  pickAppConfigEnv,
  publicValue,
  redacted,
} from "./config.ts";

const TestAppConfig = BaseAppConfig.extend({
  public: z
    .object({
      somePublicKey: z.string().default("default-public-key"),
    })
    .default({
      somePublicKey: "default-public-key",
    }),
  logger: z
    .object({
      stdout: z.boolean().default(false),
    })
    .default({
      stdout: false,
    }),
  someOtherThing: z.string().default("default-other-thing"),
});

function parseTestAppConfigFromEnv(env: Record<string, unknown>) {
  return parseAppConfigFromEnv({
    configSchema: TestAppConfig,
    prefix: "APP_CONFIG_",
    env,
  });
}

describe("parseAppConfigFromEnv", () => {
  it.each([
    {
      name: "parses base APP_CONFIG JSON",
      env: {
        APP_CONFIG: JSON.stringify({
          public: { somePublicKey: "from-base" },
          logger: { stdout: false },
          someOtherThing: "base-value",
        }),
      },
      expected: {
        logs: { stdoutFormat: "pretty", filtering: { rules: [] } },
        public: { somePublicKey: "from-base" },
        logger: { stdout: false },
        someOtherThing: "base-value",
      },
    },
    {
      name: "uses schema defaults when APP_CONFIG is missing",
      env: {},
      expected: {
        logs: { stdoutFormat: "pretty", filtering: { rules: [] } },
        public: { somePublicKey: "default-public-key" },
        logger: { stdout: false },
        someOtherThing: "default-other-thing",
      },
    },
    {
      name: "builds config from env overrides only",
      env: {
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "123",
        APP_CONFIG_LOGGER__STDOUT: "true",
        APP_CONFIG_SOME_OTHER_THING: "from-env",
      },
      expected: {
        logs: { stdoutFormat: "pretty", filtering: { rules: [] } },
        public: { somePublicKey: "123" },
        logger: { stdout: true },
        someOtherThing: "from-env",
      },
    },
    {
      name: "env overrides win over base APP_CONFIG JSON",
      env: {
        APP_CONFIG: JSON.stringify({
          public: { somePublicKey: "from-base" },
          logger: { stdout: false },
          someOtherThing: "base-value",
        }),
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "from-env",
        APP_CONFIG_LOGGER__STDOUT: "true",
      },
      expected: {
        logs: { stdoutFormat: "pretty", filtering: { rules: [] } },
        public: { somePublicKey: "from-env" },
        logger: { stdout: true },
        someOtherThing: "base-value",
      },
    },
  ])("$name", ({ env, expected }) => {
    expect(parseTestAppConfigFromEnv(env)).toEqual(expected);
  });

  it("throws for invalid APP_CONFIG JSON", () => {
    expect(() => parseTestAppConfigFromEnv({ APP_CONFIG: "{" })).toThrow(
      "APP_CONFIG must be valid JSON",
    );
  });

  it("accepts APP_CONFIG_LOGS__STDOUT_FORMAT for logs.stdoutFormat", () => {
    expect(
      parseTestAppConfigFromEnv({
        APP_CONFIG_LOGS__STDOUT_FORMAT: "raw",
      }),
    ).toEqual({
      logs: {
        stdoutFormat: "raw",
        filtering: {
          rules: [],
        },
      },
      public: {
        somePublicKey: "default-public-key",
      },
      logger: {
        stdout: false,
      },
      someOtherThing: "default-other-thing",
    });
  });

  it("throws for unknown APP_CONFIG_* keys instead of silently ignoring them", () => {
    expect(() =>
      parseTestAppConfigFromEnv({
        APP_CONFIG_LOGGING: JSON.stringify({
          stdoutFormat: "raw",
        }),
      }),
    ).toThrow(
      'Unknown config key "logging" from env var "APP_CONFIG_LOGGING". This env var is not consumed by the config schema.',
    );
  });

  it("applies a leaf override after an object override when the leaf env var comes later", () => {
    const Config = z.object({
      posthog: z.object({
        apiKey: z.string(),
        host: z.string(),
      }),
    });

    expect(
      parseAppConfigFromEnv({
        configSchema: Config,
        prefix: "APP_CONFIG_",
        env: {
          APP_CONFIG_POSTHOG: JSON.stringify({
            apiKey: "from-object",
            host: "https://eu.i.posthog.com",
          }),
          APP_CONFIG_POSTHOG__API_KEY: "from-leaf",
        },
      }),
    ).toEqual({
      posthog: {
        apiKey: "from-leaf",
        host: "https://eu.i.posthog.com",
      },
    });
  });

  it("replaces an earlier leaf override when the object env var comes later", () => {
    const Config = z.object({
      posthog: z.object({
        apiKey: z.string(),
        host: z.string(),
      }),
    });

    const env: Record<string, string> = {};
    env.APP_CONFIG_POSTHOG__API_KEY = "from-leaf";
    env.APP_CONFIG_POSTHOG = JSON.stringify({
      apiKey: "from-object",
      host: "https://eu.i.posthog.com",
    });

    expect(
      parseAppConfigFromEnv({
        configSchema: Config,
        prefix: "APP_CONFIG_",
        env,
      }),
    ).toEqual({
      posthog: {
        apiKey: "from-object",
        host: "https://eu.i.posthog.com",
      },
    });
  });
});

describe("pickAppConfigEnv", () => {
  it.each([
    {
      name: "keeps APP_CONFIG and APP_CONFIG_* string values",
      env: {
        APP_CONFIG: "{}",
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "123",
        DB_PATH: "example.db",
      },
      expected: {
        APP_CONFIG: "{}",
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "123",
      },
    },
    {
      name: "ignores non-string values",
      env: {
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "123",
        APP_CONFIG_DB: { skip: true },
      },
      expected: {
        APP_CONFIG_PUBLIC__SOME_PUBLIC_KEY: "123",
      },
    },
  ])("$name", ({ env, expected }) => {
    expect(pickAppConfigEnv(env)).toEqual(expected);
  });
});

describe("redacted", () => {
  it("redacts stringification and inspect output", () => {
    const secret = new Redacted("super-secret-123");

    expect(secret.exposeSecret()).toBe("super-secret-123");
    expect(String(secret)).toBe("REDACTED");
    expect(JSON.stringify({ secret })).toBe('{"secret":"REDACTED"}');
    expect(inspect(secret)).toBe("Redacted {}");
  });

  it("wraps parsed schema values and tags visibility", () => {
    const User = z.object({
      id: z.string(),
      email: redacted(z.email()),
      password: redacted(z.string()),
      name: z.string(),
    });

    const user = User.parse({
      id: "123",
      email: "user@example.com",
      password: "super-secret-123",
      name: "Alice",
    });

    expect(user.email).toBeInstanceOf(Redacted);
    expect(user.password).toBeInstanceOf(Redacted);
    expect(user.email.exposeSecret()).toBe("user@example.com");
    expect(user.password.exposeSecret()).toBe("super-secret-123");
    expect(inspect(user)).toContain("email: Redacted {}");
    expect(inspect(user)).toContain("password: Redacted {}");
    expect(JSON.stringify(user)).toBe(
      '{"id":"123","email":"REDACTED","password":"REDACTED","name":"Alice"}',
    );
    expect(getConfigVisibility(redacted(z.string()))).toBe("redacted");
  });
});

describe("public config helpers", () => {
  const Config = z.object({
    pirateSecret: redacted(z.string()),
    posthog: z.object({
      apiKey: publicValue(z.string()),
    }),
    nested: z.object({
      privateValue: z.string(),
      deep: z.object({
        enabled: publicValue(z.boolean()),
      }),
    }),
    tags: publicValue(z.array(z.string())),
  });

  it("extracts the public config schema and value", () => {
    const config = Config.parse({
      pirateSecret: "ahoy",
      posthog: {
        apiKey: "phc_public_key",
      },
      nested: {
        privateValue: "hidden",
        deep: {
          enabled: true,
        },
      },
      tags: ["alpha", "beta"],
    });

    const publicConfigSchema = extractPublicConfigSchema(Config);

    expect(getConfigVisibility(publicValue(z.string()))).toBe("public");
    expect(publicConfigSchema.parse(config)).toEqual({
      posthog: {
        apiKey: "phc_public_key",
      },
      nested: {
        deep: {
          enabled: true,
        },
      },
      tags: ["alpha", "beta"],
    });
    expect(getPublicConfig(config, Config)).toEqual({
      posthog: {
        apiKey: "phc_public_key",
      },
      nested: {
        deep: {
          enabled: true,
        },
      },
      tags: ["alpha", "beta"],
    });
  });

  it("exposes the correct public config types", () => {
    const config = Config.parse({
      pirateSecret: "ahoy",
      posthog: {
        apiKey: "phc_public_key",
      },
      nested: {
        privateValue: "hidden",
        deep: {
          enabled: true,
        },
      },
      tags: ["alpha", "beta"],
    });

    const publicConfig = getPublicConfig(config, Config);

    expectTypeOf(publicConfig).toEqualTypeOf<{
      posthog: {
        apiKey: string;
      };
      nested: {
        deep: {
          enabled: boolean;
        };
      };
      tags: string[];
    }>();
  });
});
