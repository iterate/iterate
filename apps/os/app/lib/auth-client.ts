import { createAuthClient } from "better-auth/react";
import { adminClient, deviceAuthorizationClient, emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_AUTH_APP_ORIGIN,
  plugins: [adminClient(), deviceAuthorizationClient(), emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;
