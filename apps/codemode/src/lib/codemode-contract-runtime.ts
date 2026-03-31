import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type {
  CodemodeContractSourceService,
  CodemodeOpenApiSource,
  CodemodeSource,
} from "@iterate-com/codemode-contract";
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
import { normalizeCodemodeSources } from "~/lib/codemode-sources.ts";
import {
  deriveContractContext,
  type ContractRegistry,
  type DerivedContractContext,
} from "~/lib/derive-contract-context.ts";
import {
  buildOpenApiCodemodeContext,
  type CodemodeOpenApiSource as RuntimeOpenApiSource,
} from "~/lib/openapi-codemode-context.ts";

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

function createContractRegistry(
  config: AppConfig,
): Record<CodemodeContractSourceService, ContractRegistry[string]> {
  const clients = createCodemodeClients(config);

  return {
    example: {
      contract: {
        common: exampleContract.common,
        ping: exampleContract.ping,
        pirateSecret: exampleContract.pirateSecret,
        test: {
          logDemo: exampleContract.test.logDemo,
          randomLogStream: exampleContract.test.randomLogStream,
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
          randomLogStream: clients.example.test.randomLogStream,
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
        stream: eventsContract.stream,
      },
      client: {
        common: clients.events.common,
        append: clients.events.append,
        getState: clients.events.getState,
        listStreams: clients.events.listStreams,
        secrets: clients.events.secrets,
        stream: clients.events.stream,
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
  };
}

function resolveOpenApiSource(
  config: AppConfig,
  source: CodemodeOpenApiSource,
): RuntimeOpenApiSource {
  const runtimeSource: RuntimeOpenApiSource = { ...source };
  const normalizedUrl = trimTrailingSlash(source.url);
  const eventsOpenApiUrl = `${trimTrailingSlash(config.codemodeApis.eventsBaseUrl)}/api/openapi.json`;

  if (
    normalizedUrl === eventsOpenApiUrl ||
    (source.namespace === "events" && normalizedUrl.endsWith("/api/openapi.json"))
  ) {
    runtimeSource.operationAliases = {
      appendStreamEvents: "append",
      streamEvents: "stream",
      getStreamState: "getState",
    };
  }

  return runtimeSource;
}

function mergeCodemodeContexts(contexts: DerivedContractContext[]): DerivedContractContext {
  const fetchTypeExpression = "{ fetch: typeof fetch }";

  if (contexts.length === 0) {
    return {
      declarations: [],
      ctxExpression: "{ fetch }",
      ctxTypeExpression: fetchTypeExpression,
      providers: [],
      sandboxPrelude: "const ctx = { fetch };",
      ctxTypes: "declare const ctx: { fetch: typeof fetch };",
    };
  }

  if (contexts.length === 1) {
    const context = contexts[0]!;
    return {
      ...context,
      ctxExpression: `Object.assign({ fetch }, ${context.ctxExpression})`,
      ctxTypeExpression: `${fetchTypeExpression} & (${context.ctxTypeExpression})`,
      sandboxPrelude: `const ctx = Object.assign({ fetch }, ${context.ctxExpression});`,
      ctxTypes: [
        ...context.declarations,
        "",
        `declare const ctx: ${fetchTypeExpression} & (${context.ctxTypeExpression});`,
        "",
      ].join("\n"),
    };
  }

  const declarations = contexts.flatMap((context) => context.declarations);
  const ctxExpression = `Object.assign({ fetch }, ${contexts
    .map((context) => context.ctxExpression)
    .join(", ")})`;
  const ctxTypeExpression = [fetchTypeExpression]
    .concat(contexts.map((context) => `(${context.ctxTypeExpression})`))
    .join(" & ");

  return {
    declarations,
    ctxExpression,
    ctxTypeExpression,
    providers: contexts.flatMap((context) => context.providers),
    sandboxPrelude: `const ctx = ${ctxExpression};`,
    ctxTypes: [...declarations, "", `declare const ctx: ${ctxTypeExpression};`, ""].join("\n"),
  };
}

export async function buildCodemodeContextFromSources(options: {
  config: AppConfig;
  sources?: CodemodeSource[];
}) {
  const selectedSources = normalizeCodemodeSources(options.sources ?? []);
  const contractRegistry = createContractRegistry(options.config);
  const contexts: DerivedContractContext[] = [];

  const selectedContractRegistry = Object.fromEntries(
    selectedSources.flatMap((source) => {
      if (source.type !== "orpc-contract") return [];
      return [[source.service, contractRegistry[source.service]]];
    }),
  ) as ContractRegistry;

  if (Object.keys(selectedContractRegistry).length > 0) {
    contexts.push(
      deriveContractContext(selectedContractRegistry, {
        providerName: "contract",
      }),
    );
  }

  const openApiSources = selectedSources
    .filter((source): source is CodemodeOpenApiSource => source.type === "openapi")
    .map((source) => resolveOpenApiSource(options.config, source));

  if (openApiSources.length > 0) {
    contexts.push(
      await buildOpenApiCodemodeContext(openApiSources, {
        providerName: "openapi",
      }),
    );
  }

  return mergeCodemodeContexts(contexts);
}
