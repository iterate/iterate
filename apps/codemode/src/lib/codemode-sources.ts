import {
  CodemodeSource,
  type CodemodeOpenApiSource as CodemodeUiOpenApiSource,
  type CodemodeSource as CodemodeUiSource,
} from "@iterate-com/codemode-contract";
import YAML from "yaml";

export type { CodemodeUiOpenApiSource, CodemodeUiSource };

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

export const SEMAPHORE_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "semaphore",
  url: "https://semaphore.iterate.com/api/openapi.json",
};

export const INGRESS_PROXY_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "ingressProxy",
  url: "https://ingress.iterate.com/api/openapi.json",
};

export const WEATHER_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "weather",
  url: "https://api.weather.gov/openapi.json",
  headers: {
    "user-agent": "iterate-codemode (jonas@iterate.com)",
    accept:
      "application/geo+json, application/vnd.oai.openapi+json, application/json;q=0.9, */*;q=0.1",
  },
};

export const AGENTUTIL_GEOCODE_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "geocode",
  url: "https://geocode.agentutil.net/openapi.json",
};

export const AGENTUTIL_TIME_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "time",
  url: "https://time.agentutil.net/openapi.json",
};

export const AGENTUTIL_WEATHER_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "agentWeather",
  url: "https://weather.agentutil.net/openapi.json",
};

export const NAGER_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "nager",
  url: "https://date.nager.at/openapi/v4.json",
};

export const OPEN_LIBRARY_OPENAPI_SOURCE: CodemodeUiOpenApiSource = {
  type: "openapi",
  namespace: "openlibrary",
  url: "https://openlibrary.org/static/openapi.json",
  headers: {
    "user-agent": "iterate-codemode (jonas@iterate.com)",
  },
};

export const DEFAULT_CODEMODE_SOURCES: CodemodeUiSource[] = [
  EXAMPLE_OPENAPI_SOURCE,
  EVENTS_OPENAPI_SOURCE,
  INGRESS_PROXY_OPENAPI_SOURCE,
  PETSTORE_OPENAPI_SOURCE,
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
    id: "ingress-openapi",
    title: "Ingress Proxy OpenAPI",
    description: "Use ingress-proxy via its public OpenAPI document with host-managed auth.",
    source: INGRESS_PROXY_OPENAPI_SOURCE,
  },
  {
    id: "weather-openapi",
    title: "Weather.gov OpenAPI",
    description: "Public NOAA weather alerts and forecast endpoints via OpenAPI.",
    source: WEATHER_OPENAPI_SOURCE,
  },
  {
    id: "agentutil-geocode-openapi",
    title: "AgentUtil Geocode",
    description: "Public geocoding OpenAPI. Small, clean, and good for mash-ups.",
    source: AGENTUTIL_GEOCODE_OPENAPI_SOURCE,
  },
  {
    id: "agentutil-time-openapi",
    title: "AgentUtil Time",
    description: "Public time/timezone OpenAPI. Useful, but quota-limited.",
    source: AGENTUTIL_TIME_OPENAPI_SOURCE,
  },
  {
    id: "agentutil-weather-openapi",
    title: "AgentUtil Weather",
    description: "Public weather OpenAPI with a small free quota. Good for lightweight demos.",
    source: AGENTUTIL_WEATHER_OPENAPI_SOURCE,
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
    id: "ingress-contract",
    title: "Ingress Proxy oRPC Contract",
    description: "Use the vendored ingress proxy contract and its typed client.",
    source: { type: "orpc-contract", service: "ingressProxy" },
  },
];

export function normalizeCodemodeSources(sources: CodemodeUiSource[]) {
  const parsed = CodemodeSource.array().parse(sources);
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
  return normalizeCodemodeSources(CodemodeSource.array().parse(YAML.parse(yamlText)));
}

export const DEFAULT_CODEMODE_SOURCES_YAML = formatCodemodeSourcesYaml(DEFAULT_CODEMODE_SOURCES);
