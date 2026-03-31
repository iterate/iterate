import type { SharedRequestLogger } from "@iterate-com/shared/request-logging";
import manifest, { type AppConfig } from "~/app.ts";
import type { RegistryDatabase } from "~/db/index.ts";
import type { PtyHookFactory } from "~/lib/pty.ts";
import type { RegistryStore } from "~/lib/registry-store.ts";

export interface RuntimeEnv {
  REGISTRY_APP_HOST: string;
  REGISTRY_APP_PORT: number;
  REGISTRY_DB_PATH: string;
  REGISTRY_DB_STUDIO_EMBED_URL: string;
  REGISTRY_DB_STUDIO_NAME: string;
  REGISTRY_DB_BASIC_AUTH_USER?: string;
  REGISTRY_DB_BASIC_AUTH_PASS: string;
  SYNC_TO_CADDY_PATH?: string;
  ITERATE_INGRESS_HOST: string;
  ITERATE_INGRESS_ROUTING_TYPE: "dunder-prefix" | "subdomain-host";
  ITERATE_INGRESS_DEFAULT_APP: string;
}

export interface AppContext {
  manifest: typeof manifest;
  config: AppConfig;
  env: RuntimeEnv;
  db: RegistryDatabase;
  getStore: () => Promise<RegistryStore>;
  pty: PtyHookFactory;
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
