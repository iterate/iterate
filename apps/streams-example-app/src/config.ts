import { BaseAppConfig, redacted } from "@iterate-com/shared/config";
import { z } from "zod";

const IgnoredSecret = redacted(z.unknown()).optional();

export const AppConfig = BaseAppConfig.extend({
  integrations: z
    .looseObject({
      google: z
        .looseObject({
          oauthClientId: IgnoredSecret,
          oauthClientSecret: IgnoredSecret,
        })
        .optional(),
    })
    .default({}),
  posthog: z
    .looseObject({
      apiKey: IgnoredSecret,
    })
    .optional(),
});
export type AppConfig = typeof AppConfig._output;
