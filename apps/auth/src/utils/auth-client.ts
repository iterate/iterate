import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import {
  deviceAuthorizationClient,
  emailOTPClient,
  multiSessionClient,
} from "better-auth/client/plugins";
import { useRouteContext } from "@tanstack/react-router";
import { getAuthAppOrigin } from "./auth-app-origin.ts";

// Only the client plugins the UI actually calls: oauth2.* (consent flows),
// device.* (CLI authorization), emailOtp.* (sign-in), and multiSession.* (the
// OAuth account chooser). Organization/project management goes through the
// typed oRPC client (utils/query.tsx), not better-auth's organization client
// plugin.
export const authClient = createAuthClient({
  baseURL: getAuthAppOrigin(),
  plugins: [
    oauthProviderClient(),
    deviceAuthorizationClient(),
    emailOTPClient(),
    multiSessionClient(),
  ],
  fetchOptions: { throw: true },
});

export function useSession() {
  const { session } = useRouteContext({ from: "/_auth" });
  return session;
}
