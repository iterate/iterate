import { z } from "zod";

export const OAuthScope = z.enum(["iterate", "account"]);
/** Project access is always required; account authority is separately consented. */
export const OAuthScopes = z
  .array(OAuthScope)
  .transform((scopes) => [...new Set(["iterate", ...scopes])]);
