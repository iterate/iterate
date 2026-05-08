import { sqlfuBetterAuthAdapter } from "sqlfu/better-auth";
import { betterAuth } from "better-auth";
import { getAuthPlugins } from "./auth-plugins.ts";

export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "secret",
  plugins: getAuthPlugins({}),
  database: sqlfuBetterAuthAdapter(),
});
