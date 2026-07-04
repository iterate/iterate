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
  // Kills better-auth's redirectPlugin, which auto-navigates whenever a
  // response carries `{redirect: true, url}`. Our mutation handlers navigate
  // explicitly, so with the plugin active every oauth2.continue/consent ended
  // in TWO simultaneous navigations to the OS callback — a race to redeem the
  // single-use authorization code that intermittently lost and rendered
  // "OAuth callback exchange failed: ... invalid_verification" (the dominant
  // preview e2e signup flake; see docs/preview-e2e-flake-hunt.md). Every
  // navigation after an authClient call must therefore be explicit.
  disableDefaultFetchPlugins: true,
  fetchOptions: { throw: true },
});

export function useSession() {
  const { session } = useRouteContext({ from: "/_auth" });
  return session;
}
