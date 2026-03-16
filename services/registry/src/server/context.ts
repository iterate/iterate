import {
  initializeServiceEvlog,
  initializeServiceOtel,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { registryServiceEnvSchema } from "@iterate-com/registry-contract";
import { ServicesStore } from "./store.ts";

export type RegistryEnv = ReturnType<typeof registryServiceEnvSchema.parse>;

export interface RegistryContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
  getStore: () => Promise<ServicesStore>;
  env: RegistryEnv;
}

export const serviceName = "jonasland-registry-service";

const registryRuntimeDefaults = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
} as const;

let envCache: RegistryEnv | null = null;
let storePromise: Promise<ServicesStore> | null = null;

function applyRegistryRuntimeEnvDefaults() {
  for (const [key, value] of Object.entries(registryRuntimeDefaults)) {
    const current = process.env[key];
    if (current === undefined || current.trim().length === 0) {
      process.env[key] = value;
    }
  }
}

applyRegistryRuntimeEnvDefaults();
initializeServiceOtel(serviceName);
initializeServiceEvlog(serviceName);

export function getEnv() {
  envCache ??= registryServiceEnvSchema.parse(process.env);
  return envCache;
}

export function getStore(): Promise<ServicesStore> {
  if (!storePromise) {
    storePromise = ServicesStore.open(getEnv().REGISTRY_DB_PATH);
  }
  return storePromise;
}
