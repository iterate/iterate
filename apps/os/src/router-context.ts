import type { QueryClient } from "@tanstack/react-query";
import type { PublicSessionResponse } from "@iterate-com/auth/client";

/**
 * The router context provided to createRouter and augmented by the root
 * route's beforeLoad (https://tanstack.com/router/latest/docs/framework/react/guide/router-context).
 *
 * Lives in its own module on purpose: routeTree.gen.ts references
 * `typeof getRouter` in its generated Register block, so if route files
 * imported anything from router.tsx the route tree's types would become
 * circular (TS7022/TS7023).
 */
export type RouterContext = {
  queryClient: QueryClient;
  authSession?: PublicSessionResponse;
  currentProjectHostSlug?: string | null;
  iterateAuthIssuer?: string;
};
