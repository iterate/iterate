/**
 * The only module exported as `@iterate-com/auth/server`. Implementation and
 * test hooks stay package-private in sibling modules.
 */
export {
  createIterateAuth,
  isAuthHandlerRequest,
  withAuthenticationResponseHeaders,
  type AuthenticateErrorEvent,
  type IterateAuthConfig,
} from "./server.ts";
export { identityFromAccessToken, identityFromSession } from "./session.ts";
export type { AccessTokenClaims, AuthenticatedIdentity, AuthenticatedSession } from "./session.ts";
