import { z } from "zod/v4";

export const OsPlaywrightAuthEnv = z.object({
  /** OS admin handle used to create and clean up fixture projects through /api/itx. */
  APP_CONFIG_ADMIN_API_SECRET: z.string().min(1),
  /** OAuth client id used as the id-token audience. */
  APP_CONFIG_ITERATE_AUTH__CLIENT_ID: z.string().min(1),
  /** Auth issuer used for both forged access and id tokens. */
  APP_CONFIG_ITERATE_AUTH__ISSUER: z.url(),
  /** Private half of the ES256 Auth signing key whose public half OS trusts. */
  AUTH_FORGE_ES256_PRIVATE_JWK: z
    .string()
    .min(1)
    .refine((value) => {
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, "must be the forge private JWK as a JSON string"),
});

// Suite setup supplies these values before Playwright creates its workers.
// Fixtures only read prepared configuration; they never fetch secrets.
export function readOsPlaywrightAuthConfig() {
  const env = OsPlaywrightAuthEnv.parse(process.env);
  return {
    adminApiSecret: env.APP_CONFIG_ADMIN_API_SECRET,
    clientId: env.APP_CONFIG_ITERATE_AUTH__CLIENT_ID,
    forgePrivateJwk: env.AUTH_FORGE_ES256_PRIVATE_JWK,
    issuer: env.APP_CONFIG_ITERATE_AUTH__ISSUER,
  };
}

export type OsPlaywrightAuthConfig = ReturnType<typeof readOsPlaywrightAuthConfig>;
