import { CodemodeContractSourceService } from "@iterate-com/codemode-contract";
import { z } from "zod";
import YAML from "yaml";

export const CodemodeUiOpenApiSource = z.object({
  type: z.literal("openapi"),
  url: z.string().trim().url(),
  baseUrl: z.string().trim().url().optional(),
  namespace: z.string().trim().min(1).optional(),
});

export const CodemodeUiOrpcContractSource = z.object({
  type: z.literal("orpc-contract"),
  service: CodemodeContractSourceService,
});

export const CodemodeUiSource = z.discriminatedUnion("type", [
  CodemodeUiOpenApiSource,
  CodemodeUiOrpcContractSource,
]);

export type CodemodeUiSource = z.infer<typeof CodemodeUiSource>;
export type CodemodeUiOpenApiSource = z.infer<typeof CodemodeUiOpenApiSource>;

export interface CodemodeSourcePreset {
  id: string;
  title: string;
  description: string;
  source: CodemodeUiSource;
}

export const PETSTORE_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "petstore",
  url: "https://petstore3.swagger.io/api/v3/openapi.json",
};

export const EXAMPLE_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "example",
  url: "https://example.iterate.com/api/openapi.json",
};

export const EVENTS_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "events",
  url: "https://events.iterate.com/api/openapi.json",
};

export const WEATHER_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "weather",
  url: "https://api.weather.gov/openapi.json",
};

export const OPENF1_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "openf1",
  url: "https://api.openf1.org/openapi.json",
};

export const DEFAULT_CODEMODE_SOURCES: CodemodeUiSource[] = [
  PETSTORE_OPENAPI_SOURCE,
  EXAMPLE_OPENAPI_SOURCE,
  EVENTS_OPENAPI_SOURCE,
  { type: "orpc-contract", service: "semaphore" },
  { type: "orpc-contract", service: "ingressProxy" },
];

export const CODEMODE_SOURCE_PRESETS: CodemodeSourcePreset[] = [
  {
    id: "petstore-openapi",
    title: "Swagger Petstore",
    description: "Classic public OpenAPI sample with pets, users, and store endpoints.",
    source: PETSTORE_OPENAPI_SOURCE,
  },
  {
    id: "example-openapi",
    title: "Example OpenAPI",
    description: "Use the live example app OpenAPI document as a ctx source.",
    source: EXAMPLE_OPENAPI_SOURCE,
  },
  {
    id: "events-openapi",
    title: "Events OpenAPI",
    description: "Use the live events app OpenAPI document as a ctx source.",
    source: EVENTS_OPENAPI_SOURCE,
  },
  {
    id: "weather-openapi",
    title: "Weather.gov OpenAPI",
    description: "National Weather Service OpenAPI with alerts, forecasts, and stations.",
    source: WEATHER_OPENAPI_SOURCE,
  },
  {
    id: "openf1-openapi",
    title: "OpenF1 OpenAPI",
    description: "Public Formula 1 telemetry and event data exposed as OpenAPI.",
    source: OPENF1_OPENAPI_SOURCE,
  },
  {
    id: "example-contract",
    title: "Example oRPC Contract",
    description: "Use the vendored example contract and its typed client.",
    source: { type: "orpc-contract", service: "example" },
  },
  {
    id: "events-contract",
    title: "Events oRPC Contract",
    description: "Use the vendored events contract and its typed client.",
    source: { type: "orpc-contract", service: "events" },
  },
  {
    id: "semaphore-contract",
    title: "Semaphore oRPC Contract",
    description: "Use the vendored semaphore contract and its typed client.",
    source: { type: "orpc-contract", service: "semaphore" },
  },
  {
    id: "ingress-contract",
    title: "Ingress Proxy oRPC Contract",
    description: "Use the vendored ingress proxy contract and its typed client.",
    source: { type: "orpc-contract", service: "ingressProxy" },
  },
];

export function normalizeCodemodeSources(sources: CodemodeUiSource[]) {
  const parsed = CodemodeUiSource.array().parse(sources);
  const seen = new Set<string>();
  const unique: CodemodeUiSource[] = [];

  for (const source of parsed) {
    const key = JSON.stringify(source);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(source);
  }

  return unique;
}

export function formatCodemodeSourcesYaml(sources: CodemodeUiSource[]) {
  return YAML.stringify(normalizeCodemodeSources(sources));
}

export function parseCodemodeSourcesYaml(yamlText: string) {
  return normalizeCodemodeSources(CodemodeUiSource.array().parse(YAML.parse(yamlText)));
}

export const DEFAULT_CODEMODE_SOURCES_YAML = formatCodemodeSourcesYaml(DEFAULT_CODEMODE_SOURCES);
