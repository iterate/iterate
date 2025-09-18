import type { BetterAuthClientPlugin } from "better-auth";
import type { integrationsPlugin } from "../../backend/auth/integrations"; // make sure to import the server plugin as a type
type IntegrationsPlugin = typeof integrationsPlugin;

export const integrationsClientPlugin = () => {
  return {
    id: "integrationsPlugin",
    $InferServerPlugin: {} as ReturnType<IntegrationsPlugin>,
  } satisfies BetterAuthClientPlugin;
};
