import "./body-init-global.ts";
import {
  createClient,
  createConfig,
  type Client as FlyApiClient,
} from "./generated/client/index.ts";

export type { FlyApiClient };

export interface FlyApiClientOpts {
  apiToken: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export function createFlyApiClient(opts: FlyApiClientOpts): FlyApiClient {
  return createClient(
    createConfig({
      baseUrl: opts.baseUrl ?? "https://api.machines.dev/v1",
      auth: opts.apiToken,
      headers: {
        Accept: "application/json",
      },
      throwOnError: true,
      fetch: opts.fetch,
    }),
  );
}
