// src/control-plane/contract.ts — the identity providers a linked account is known by.
import { z } from "zod";
import { IntegrationProvider } from "../integrations/contract.ts";

/** The sign-in providers that prove who someone is (identity.ts, iterate/api `SignInProvider`):
 *  each names a person by a stable subject; a person links at most ONE subject per provider. */
export const IdentityProvider = IntegrationProvider.exclude(["slack", "x"]);
export type IdentityProvider = z.infer<typeof IdentityProvider>;
