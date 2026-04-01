import {
  AGENTUTIL_GEOCODE_OPENAPI_SOURCE,
  AGENTUTIL_WEATHER_OPENAPI_SOURCE,
  DEFAULT_CODEMODE_SOURCES,
  EVENTS_OPENAPI_SOURCE,
  EXAMPLE_OPENAPI_SOURCE,
  INGRESS_PROXY_OPENAPI_SOURCE,
  NAGER_OPENAPI_SOURCE,
  OPEN_LIBRARY_OPENAPI_SOURCE,
  PETSTORE_OPENAPI_SOURCE,
  POSTMAN_ECHO_INLINE_OPENAPI_SOURCE,
  USGS_WATER_OPENAPI_SOURCE,
  WEATHER_OPENAPI_SOURCE,
  type CodemodeUiSource,
} from "~/lib/codemode-sources.ts";

export interface CodemodeExampleSnippet {
  id: string;
  title: string;
  description: string;
  code: string;
  sources: CodemodeUiSource[];
}

export const CODEMODE_EXAMPLES: CodemodeExampleSnippet[] = [
  {
    id: "postman-echo-inline",
    title: "Inline Echo Debug",
    description: "Use an inline OpenAPI spec to inspect echoed query params and request headers.",
    sources: [POSTMAN_ECHO_INLINE_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const echoedQuery = await ctx.echo.get({
    foo: "codemode",
    bar: "inline-openapi",
  });

  const echoedHeaders = await ctx.echo.headers({});

  return {
    args: echoedQuery.args ?? null,
    xForwardedProto: echoedHeaders.headers?.["x-forwarded-proto"] ?? null,
    userAgent: echoedHeaders.headers?.["user-agent"] ?? null,
  };
};`,
  },
  {
    id: "echo-secret-header",
    title: "Echo Secret Header",
    description:
      "Watch Postman Echo reflect a seeded codemode secret back through an inline OpenAPI source.",
    sources: [
      {
        ...POSTMAN_ECHO_INLINE_OPENAPI_SOURCE,
        headers: {
          "x-demo-secret": 'getIterateSecret({ secretKey: "demo.echo" })',
        },
      },
    ],
    code: `async ({ ctx }) => {
  const echoed = await ctx.echo.headers({});

  return {
    reflectedSecretHeader: echoed.headers?.["x-demo-secret"] ?? null,
    expected: "super-secret-inline-proof",
  };
};`,
  },
  {
    id: "service-overview",
    title: "Service Overview",
    description: "Ping example, count streams, inspect ingress routes, and sample Petstore data.",
    sources: DEFAULT_CODEMODE_SOURCES,
    code: `async ({ ctx }) => {
  const ping = await ctx.example.ping({});
  const streams = await ctx.events.listStreams({});
  const routes = await ctx.ingressProxy.routes.list({ limit: 5, offset: 0 });
  const pets = await ctx.petstore.findPetsByStatus({ status: "available" });

  return {
    ping,
    streamCount: streams.length,
    ingressRoutes: routes.total,
    petCount: Array.isArray(pets) ? pets.length : null,
    firstPetName: Array.isArray(pets) ? (pets[0]?.name ?? null) : null,
  };
};`,
  },
  {
    id: "event-audit",
    title: "Append And Inspect Events",
    description: "Write an event, then read back the latest stream state.",
    sources: [EXAMPLE_OPENAPI_SOURCE, EVENTS_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const append = await ctx.events.append({
    path: "/codemode/demo/audit",
    type: "com.iterate.codemode/demo-ran",
    payload: {
      createdAt: new Date().toISOString(),
      source: "codemode",
    },
  });

  const state = await ctx.events.getState({
    streamPath: "/codemode/demo/audit",
  });

  return {
    latestOffset: append.events.at(-1)?.offset ?? null,
    state,
  };
};`,
  },
  {
    id: "log-demo",
    title: "Capture Example Logs",
    description: "Run the example log demo and persist each step as an event.",
    sources: [EXAMPLE_OPENAPI_SOURCE, EVENTS_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const demo = await ctx.example.test.logDemo({
    label: "codemode-homepage-example",
  });

  await ctx.events.append({
    path: "/codemode/demo/log-steps",
    events: demo.steps.map((step) => ({
      path: "/codemode/demo/log-steps",
      type: "com.iterate.codemode/log-step-recorded",
      payload: {
        label: demo.label,
        requestId: demo.requestId,
        step,
      },
    })),
  });

  return demo;
};`,
  },
  {
    id: "lease-and-route",
    title: "Route Weather Snapshot",
    description: "Combine ingress route inventory with live California weather alerts.",
    sources: [INGRESS_PROXY_OPENAPI_SOURCE, WEATHER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const routes = await ctx.ingressProxy.routes.list({ limit: 10, offset: 0 });
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });

  const features = Array.isArray(alerts?.features) ? alerts.features : [];

  return {
    ingressRoutes: routes.total,
    sampleRoute: routes.routes[0]
      ? {
          rootHost: routes.routes[0].rootHost,
          targetUrl: routes.routes[0].targetUrl,
        }
      : null,
    alertCount: features.length,
    headline: features[0]?.properties?.headline ?? null,
  };
};`,
  },
  {
    id: "inventory-cross-check",
    title: "Ingress And Events Snapshot",
    description:
      "Cross-check ingress routes against recent event streams and summarize both sides.",
    sources: [EVENTS_OPENAPI_SOURCE, INGRESS_PROXY_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const streams = await ctx.events.listStreams({});
  const routes = await ctx.ingressProxy.routes.list({ limit: 100, offset: 0 });

  return {
    streamCount: streams.length,
    routeCount: routes.total,
    recentStreams: streams.slice(0, 5).map((stream) => stream.path),
    sampleRoutes: routes.routes.slice(0, 5).map((route) => ({
      rootHost: route.rootHost,
      targetUrl: route.targetUrl,
    })),
  };
};`,
  },
  {
    id: "petstore-status",
    title: "Petstore Status",
    description: "Pull live public pets from Swagger Petstore through the OpenAPI source.",
    sources: [PETSTORE_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const pets = await ctx.petstore.findPetsByStatus({ status: "available" });

  return {
    count: Array.isArray(pets) ? pets.length : null,
    first: Array.isArray(pets) ? (pets[0] ?? null) : null,
  };
};`,
  },
  {
    id: "weather-alerts",
    title: "Weather Alerts",
    description: "Fetch active California alerts from the Weather.gov OpenAPI source.",
    sources: [WEATHER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });

  return {
    alertCount: Array.isArray(alerts?.features) ? alerts.features.length : null,
    headline: Array.isArray(alerts?.features)
      ? (alerts.features[0]?.properties?.headline ?? null)
      : null,
  };
};`,
  },
  {
    id: "weather-alert-journal",
    title: "Weather Alert Journal",
    description:
      "Pull Weather.gov alerts and persist a summary event into the internal events app.",
    sources: [WEATHER_OPENAPI_SOURCE, EVENTS_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });

  const features = Array.isArray(alerts?.features) ? alerts.features : [];
  const headline = features[0]?.properties?.headline ?? null;

  await ctx.events.append({
    path: "/codemode/demo/weather-alerts",
    type: "com.iterate.codemode/weather-alert-snapshot",
    payload: {
      capturedAt: new Date().toISOString(),
      state: "CA",
      alertCount: features.length,
      headline,
    },
  });

  return {
    alertCount: features.length,
    headline,
  };
};`,
  },
  {
    id: "geocode-weather-brief",
    title: "Geocode Weather Brief",
    description: "Resolve a place, then fetch current weather for the returned coordinates.",
    sources: [AGENTUTIL_GEOCODE_OPENAPI_SOURCE, AGENTUTIL_WEATHER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const geocode = await ctx.geocode.forwardGeocode({
    address: "Golden Gate Bridge, San Francisco",
    limit: 1,
  });

  const place = geocode.results?.[0];
  if (!place?.lat || !place?.lon) {
    return null;
  }

  const weather = await ctx.agentWeather.getCurrentWeather({
    lat: place.lat,
    lon: place.lon,
  });

  return {
    place: place.display_name ?? null,
    coordinates: {
      lat: place.lat,
      lon: place.lon,
    },
    current: weather.current ?? null,
  };
};`,
  },
  {
    id: "formula-one-results",
    title: "Formula One Results",
    description: "Fetch recent F1 race results directly from a public endpoint.",
    sources: [],
    code: `async ({ ctx }) => {
  const response = await ctx.fetch("https://api.jolpi.ca/ergast/f1/2024/5/results.json");
  const data = await response.json();
  const race = data?.MRData?.RaceTable?.Races?.[0] ?? null;

  return race
    ? {
        raceName: race.raceName,
        round: race.round,
        winner: race.Results?.[0]?.Driver?.familyName ?? null,
      }
    : null;
};`,
  },
  {
    id: "holiday-weather-brief",
    title: "Holiday Weather Brief",
    description:
      "Mix a public holiday feed with live California alerts for a quick planning brief.",
    sources: [NAGER_OPENAPI_SOURCE, WEATHER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const holidays = await ctx.nager.nextPublicHolidays({
    countryCode: "GB",
  });
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });

  const nextHoliday = Array.isArray(holidays) ? (holidays[0] ?? null) : null;
  const features = Array.isArray(alerts?.features) ? alerts.features : [];

  return {
    nextHoliday: nextHoliday
      ? {
          name: nextHoliday.localName,
          date: nextHoliday.date,
        }
      : null,
    californiaAlertCount: features.length,
    californiaHeadline: features[0]?.properties?.headline ?? null,
  };
};`,
  },
  {
    id: "openlibrary-weather-mashup",
    title: "Storm Reading List",
    description:
      "Search Open Library and pair the result with the latest California alert headline.",
    sources: [OPEN_LIBRARY_OPENAPI_SOURCE, WEATHER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const books = await ctx.openlibrary.search({
    q: "storm survival",
  });
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });

  const docs = Array.isArray(books?.docs) ? books.docs : [];
  const features = Array.isArray(alerts?.features) ? alerts.features : [];

  return {
    headline: features[0]?.properties?.headline ?? null,
    topBooks: docs.slice(0, 3).map((book) => ({
      title: book.title ?? null,
      author: Array.isArray(book.author_name) ? (book.author_name[0] ?? null) : null,
      year: book.first_publish_year ?? null,
    })),
  };
};`,
  },
  {
    id: "holiday-reading-list",
    title: "Holiday Reading List",
    description: "Combine upcoming UK holidays with a themed Open Library search.",
    sources: [NAGER_OPENAPI_SOURCE, OPEN_LIBRARY_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const holidays = await ctx.nager.nextPublicHolidays({
    countryCode: "GB",
  });
  const books = await ctx.openlibrary.search({
    q: "storm survival",
  });

  const nextHoliday = Array.isArray(holidays) ? (holidays[0] ?? null) : null;
  const docs = Array.isArray(books?.docs) ? books.docs : [];

  return {
    nextHoliday: nextHoliday
      ? {
          name: nextHoliday.localName,
          date: nextHoliday.date,
        }
      : null,
    suggestions: docs.slice(0, 3).map((book) => ({
      title: book.title ?? null,
      author: Array.isArray(book.author_name) ? (book.author_name[0] ?? null) : null,
    })),
  };
};`,
  },
  {
    id: "weather-water-catalog",
    title: "Weather And Water Catalog",
    description: "Pair live California alerts with a quick USGS Water Data overview.",
    sources: [WEATHER_OPENAPI_SOURCE, USGS_WATER_OPENAPI_SOURCE],
    code: `async ({ ctx }) => {
  const alerts = await ctx.weather.alerts_active({
    area: "CA",
  });
  const landing = await ctx.usgs.getLandingPage({
    f: "json",
  });
  const collections = await ctx.usgs.getCollections({
    f: "json",
  });

  const features = Array.isArray(alerts?.features) ? alerts.features : [];

  return {
    californiaAlertCount: features.length,
    californiaHeadline: features[0]?.properties?.headline ?? null,
    usgsTitle: landing?.title ?? null,
    usgsCollectionCount: Array.isArray(collections?.collections)
      ? collections.collections.length
      : null,
  };
};`,
  },
  {
    id: "stream-example-logs",
    title: "Stream Example Logs",
    description: "Consume the async log stream directly with for-await.",
    sources: [{ type: "orpc-contract", service: "example" }],
    code: `async ({ ctx }) => {
  const lines = [];
  const stream = await ctx.example.test.randomLogStream({
    count: 4,
    minDelayMs: 0,
    maxDelayMs: 25,
  });

  for await (const line of stream) {
    lines.push(line);
  }

  return { lines };
};`,
  },
  {
    id: "raw-fetch-openapi",
    title: "Raw Fetch",
    description: "Use the sandbox's internet fetch directly and return JSON.",
    sources: [],
    code: `async ({ ctx }) => {
  const response = await ctx.fetch("https://api.github.com/repos/cloudflare/workers-sdk", {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "iterate-codemode",
    },
  });

  const repo = await response.json();

  return {
    full_name: repo.full_name,
    stargazers_count: repo.stargazers_count,
    open_issues_count: repo.open_issues_count,
  };
};`,
  },
];

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function normalizeUserCode(userCode: string) {
  return userCode.trim().replace(/;\s*$/, "");
}

export function buildCodemodeWrapperSource(options: { userCode: string; sandboxPrelude: string }) {
  return `async () => {
${indent(options.sandboxPrelude.trim(), 2)}
  const userFn = (${normalizeUserCode(options.userCode)});
  return await userFn({ ctx });
}`.trim();
}

export const CODEMODE_V2_STARTER = CODEMODE_EXAMPLES[0]!.code;
