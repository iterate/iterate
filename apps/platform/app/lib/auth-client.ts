import { createAuthClient } from "better-auth/react";
import { integrationsClientPlugin } from "./integrations-client.ts";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_URL || "http://localhost:5173",
  plugins: [integrationsClientPlugin()],
});
