import { sqlfuBetterAuthAdapter } from "sqlfu/better-auth";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getAuthPlugins } from "./auth-plugins.ts";

export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "secret",
  plugins: getAuthPlugins({
    authAppOrigin: "http://localhost:3000",
    // Schema extraction needs the stock plugin's tables, not a runtime key.
    jwtPlugin: jwt(),
    emailOtpEnabled: false,
    fixedTestOtpEnabled: false,
    emailBinding: undefined,
    emailSenderDomain: "",
  }),
  database: sqlfuBetterAuthAdapter(),
});
