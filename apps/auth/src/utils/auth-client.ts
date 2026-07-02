import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { deviceAuthorizationClient, emailOTPClient } from "better-auth/client/plugins";
import { useRouteContext } from "@tanstack/react-router";

// Only the client plugins the UI actually calls: oauth2.* (consent flows),
// device.* (CLI authorization), emailOtp.* (sign-in). Organization/project
// management goes through the typed oRPC client (utils/query.tsx), not
// better-auth's organization client plugin.
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_APP_ORIGIN,
  plugins: [oauthProviderClient(), deviceAuthorizationClient(), emailOTPClient()],
  fetchOptions: { throw: true },
});

export function useSession() {
  const { session } = useRouteContext({ from: "/_auth" });
  return session;
}
