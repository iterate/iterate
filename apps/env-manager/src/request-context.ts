import type { EnvManagerPrincipal } from "./auth.ts";
import type { AppConfig } from "./config.ts";

export interface RequestContext {
  config: AppConfig;
  rawRequest?: Request;
  principal?: EnvManagerPrincipal | null;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: RequestContext;
    };
  }
}
