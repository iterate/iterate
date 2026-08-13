import { createServerFn } from "@tanstack/react-start";

/** What the UI needs to know about the caller — nothing more than the gate requires. */
type AuthSnapshot = {
  authenticated: boolean;
  isAdmin: boolean;
  email?: string;
};

/**
 * Reads the request's principal (resolved by the iterate auth request
 * middleware in src/start.ts) without any auth-worker roundtrip.
 *
 * Lives outside routes/ and carries an explicit type on purpose: server
 * functions used by route files must not let route types recurse into Start's
 * Register interface (routeTree.gen.ts registers the router there, which
 * depends on the route tree — a cycle).
 */
export const fetchAuthSnapshot: () => Promise<AuthSnapshot> = createServerFn({
  method: "GET",
}).handler(async ({ context }): Promise<AuthSnapshot> => {
  const principal = context.principal ?? null;
  return {
    authenticated: !!principal,
    isAdmin: principal?.isAdmin ?? false,
    email: principal?.email,
  };
});
