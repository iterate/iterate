import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import manifest, { type AppConfig } from "~/app.ts";

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  env: Env;
  log: SharedRequestLogger;
  rawRequest?: Request;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    server: {
      requestContext: AppContext;
    };
  }
}
