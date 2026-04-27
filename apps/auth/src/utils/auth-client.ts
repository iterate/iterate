import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { organizationClient } from "better-auth/client/plugins";
import { adminClient, deviceAuthorizationClient } from "better-auth/client/plugins";
import { useRouteContext } from "@tanstack/react-router";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_APP_ORIGIN,
  plugins: [
    oauthProviderClient(),
    organizationClient(),
    adminClient(),
    deviceAuthorizationClient(),
  ],
  fetchOptions: { throw: true },
});

export function useSession() {
  const { session } = useRouteContext({ from: "/_auth" });
  return session;
}
