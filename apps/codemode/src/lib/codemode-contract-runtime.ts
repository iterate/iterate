import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@iterate-com/events-contract";
import { exampleContract } from "@iterate-com/example-contract";
import {
  createIngressProxyClient,
  type IngressProxyClient,
  ingressProxyContract,
} from "@iterate-com/ingress-proxy-contract";
import {
  createSemaphoreClient,
  type SemaphoreClient,
  semaphoreContract,
} from "@iterate-com/semaphore-contract";
import type { AppConfig } from "~/app.ts";
import { deriveContractContext } from "~/lib/derive-contract-context.ts";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function createExampleClient(config: AppConfig): ContractRouterClient<typeof exampleContract> {
  return createORPCClient(
    new OpenAPILink(exampleContract, {
      url: new URL("/api", trimTrailingSlash(config.codemodeApis.exampleBaseUrl)).toString(),
    }),
  );
}

function createEventsClient(config: AppConfig): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", trimTrailingSlash(config.codemodeApis.eventsBaseUrl)).toString(),
    }),
  );
}

function createCodemodeClients(config: AppConfig) {
  return {
    example: createExampleClient(config),
    events: createEventsClient(config),
    semaphore: createSemaphoreClient({
      baseURL: config.codemodeApis.semaphoreBaseUrl,
      apiKey: config.codemodeApis.semaphoreApiToken.exposeSecret(),
    }) as SemaphoreClient,
    ingressProxy: createIngressProxyClient({
      baseURL: config.codemodeApis.ingressProxyBaseUrl,
      apiToken: config.codemodeApis.ingressProxyApiToken.exposeSecret(),
    }) as IngressProxyClient,
  };
}

export function buildCodemodeContractContext(config: AppConfig) {
  const clients = createCodemodeClients(config);

  return deriveContractContext({
    example: {
      contract: {
        common: exampleContract.common,
        ping: exampleContract.ping,
        pirateSecret: exampleContract.pirateSecret,
        test: {
          logDemo: exampleContract.test.logDemo,
          serverThrow: exampleContract.test.serverThrow,
        },
        things: exampleContract.things,
      },
      client: {
        common: clients.example.common,
        ping: clients.example.ping,
        pirateSecret: clients.example.pirateSecret,
        test: {
          logDemo: clients.example.test.logDemo,
          serverThrow: clients.example.test.serverThrow,
        },
        things: clients.example.things,
      },
    },
    events: {
      contract: {
        common: eventsContract.common,
        append: eventsContract.append,
        getState: eventsContract.getState,
        listStreams: eventsContract.listStreams,
        secrets: eventsContract.secrets,
      },
      client: {
        common: clients.events.common,
        append: clients.events.append,
        getState: clients.events.getState,
        listStreams: clients.events.listStreams,
        secrets: clients.events.secrets,
      },
    },
    semaphore: {
      contract: semaphoreContract,
      client: clients.semaphore,
    },
    ingressProxy: {
      contract: ingressProxyContract,
      client: clients.ingressProxy,
    },
  });
}
