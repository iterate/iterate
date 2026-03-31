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
  type CodemodeOpenApiFetch,
  type CodemodeOpenApiSource as RuntimeOpenApiSource,
} from "~/lib/openapi-codemode-context.ts";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function createExampleClient(
  config: AppConfig,
  fetcher?: CodemodeOpenApiFetch,
): ContractRouterClient<typeof exampleContract> {
  return createORPCClient(
    new OpenAPILink(exampleContract, {
      url: new URL("/api", trimTrailingSlash(config.codemodeApis.exampleBaseUrl)).toString(),
      ...(fetcher ? { fetch: fetcher } : {}),
    }),
  );
}

function createEventsClient(
  config: AppConfig,
  fetcher?: CodemodeOpenApiFetch,
): ContractRouterClient<typeof eventsContract> {
  return createORPCClient(
    new OpenAPILink(eventsContract, {
      url: new URL("/api", trimTrailingSlash(config.codemodeApis.eventsBaseUrl)).toString(),
      ...(fetcher ? { fetch: fetcher } : {}),
    }),
  );
}

function createCodemodeClients(config: AppConfig, fetcher?: CodemodeOpenApiFetch) {
  return {
    example: createExampleClient(config, fetcher),
    events: createEventsClient(config, fetcher),
    semaphore: createSemaphoreClient({
      baseURL: config.codemodeApis.semaphoreBaseUrl,
      apiKey: config.codemodeApis.semaphoreApiToken.exposeSecret(),
      ...(fetcher ? { fetch: fetcher } : {}),
    }) as SemaphoreClient,
    ingressProxy: createIngressProxyClient({
      baseURL: config.codemodeApis.ingressProxyBaseUrl,
      apiToken: config.codemodeApis.ingressProxyApiToken.exposeSecret(),
      ...(fetcher ? { fetch: fetcher } : {}),
    }) as IngressProxyClient,
  };
}

function createContractRegistry(
  config: AppConfig,
  fetcher?: CodemodeOpenApiFetch,
): Record<CodemodeContractSourceService, ContractRegistry[string]> {
  const clients = createCodemodeClients(config, fetcher);

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
  const semaphoreOpenApiUrl = `${trimTrailingSlash(config.codemodeApis.semaphoreBaseUrl)}/api/openapi.json`;
  const ingressOpenApiUrl = `${trimTrailingSlash(config.codemodeApis.ingressProxyBaseUrl)}/api/openapi.json`;
  const nagerOpenApiUrl = "https://date.nager.at/openapi/v4.json";
  const openLibraryOpenApiUrl = "https://openlibrary.org/static/openapi.json";

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

  if (
    normalizedUrl === semaphoreOpenApiUrl ||
    (source.namespace === "semaphore" && normalizedUrl.endsWith("/api/openapi.json"))
  ) {
    runtimeSource.headers = {
      ...source.headers,
      Authorization: `Bearer ${config.codemodeApis.semaphoreApiToken.exposeSecret()}`,
    };
  }

  if (
    normalizedUrl === ingressOpenApiUrl ||
    (source.namespace === "ingressProxy" && normalizedUrl.endsWith("/api/openapi.json"))
  ) {
    runtimeSource.headers = {
      ...source.headers,
      Authorization: `Bearer ${config.codemodeApis.ingressProxyApiToken.exposeSecret()}`,
    };
  }

  if (
    normalizedUrl === nagerOpenApiUrl ||
    (source.namespace === "nager" && normalizedUrl.endsWith("/openapi/v4.json"))
  ) {
    runtimeSource.operationAliases = {
      ...runtimeSource.operationAliases,
      "get.api.v4.PublicHolidays.year.countryCode": "publicHolidays",
      "get.api.v4.IsTodayPublicHoliday.countryCode": "isTodayPublicHoliday",
      "get.api.v4.NextPublicHolidays.countryCode": "nextPublicHolidays",
      "get.api.v4.NextPublicHolidaysWorldwide": "nextPublicHolidaysWorldwide",
      "get.api.v4.Version": "version",
    };
  }

  if (
    normalizedUrl === openLibraryOpenApiUrl ||
    (source.namespace === "openlibrary" && normalizedUrl.endsWith("/static/openapi.json"))
  ) {
    runtimeSource.operationAliases = {
      ...runtimeSource.operationAliases,
      read_api_books_api_books_get: "books",
      read_api_volumes_brief_api_volumes_brief__key_type___value__json_get: "volumesBrief",
      read_authors_authors__olid__json_get: "author",
      read_authors_works_authors__olid__works_json_get: "authorWorks",
      read_books_books__olid__get: "book",
      read_covers_key_type_value_size_jpeg_covers__key_type___value___size__jpg_get: "cover",
      read_isbn_isbn__isbn__get: "isbn",
      read_search_json_search_json_get: "search",
      read_search_authors_json_search_authors_json_get: "searchAuthors",
      read_subjects_subjects__subject__json_get: "subject",
      read_works_works__olid__get: "work",
    };
  }

  return runtimeSource;
}

function mergeCodemodeContexts(contexts: DerivedContractContext[]): DerivedContractContext {
  const fetchTypeExpression = "{ fetch: typeof fetch }";
  const fetchRuntimeExpression = "{ fetch: (...args) => fetch(...args) }";

  if (contexts.length === 0) {
    return {
      declarations: [],
      ctxExpression: fetchRuntimeExpression,
      ctxTypeExpression: fetchTypeExpression,
      providers: [],
      sandboxPrelude: "const ctx = { fetch: (...args) => fetch(...args) };",
      ctxTypes: "declare const ctx: { fetch: typeof fetch };",
    };
  }

  if (contexts.length === 1) {
    const context = contexts[0]!;
    return {
      ...context,
      ctxExpression: `Object.assign(${fetchRuntimeExpression}, ${context.ctxExpression})`,
      ctxTypeExpression: `${fetchTypeExpression} & (${context.ctxTypeExpression})`,
      sandboxPrelude: `const ctx = Object.assign(${fetchRuntimeExpression}, ${context.ctxExpression});`,
      ctxTypes: [
        ...context.declarations,
        "",
        `declare const ctx: ${fetchTypeExpression} & (${context.ctxTypeExpression});`,
        "",
      ].join("\n"),
    };
  }

  const declarations = contexts.flatMap((context) => context.declarations);
  const ctxExpression = `Object.assign(${fetchRuntimeExpression}, ${contexts
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
  fetch?: CodemodeOpenApiFetch;
  includeTypes?: boolean;
}) {
  const selectedSources = normalizeCodemodeSources(options.sources ?? []);
  const contractRegistry = createContractRegistry(options.config, options.fetch);
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
        includeTypes: options.includeTypes,
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
        fetch: options.fetch,
        includeTypes: options.includeTypes,
      }),
    );
  }

  return mergeCodemodeContexts(contexts);
}
