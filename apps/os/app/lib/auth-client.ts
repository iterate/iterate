import { createAuthClient } from "better-auth/react";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { integrationsClientPlugin } from "./integrations-client.ts";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_URL || "http://localhost:5173",
  plugins: [adminClient(), integrationsClientPlugin(), emailOTPClient()],
  fetchOptions: { throw: true },
});
