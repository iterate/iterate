import {
  DEFAULT_CODEMODE_SOURCES,
  EVENTS_OPENAPI_SOURCE,
  EXAMPLE_OPENAPI_SOURCE,
  PETSTORE_OPENAPI_SOURCE,
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
    id: "service-overview",
    title: "Service Overview",
    description:
      "Ping example, count streams, inspect semaphore inventory, and list ingress routes.",
    sources: DEFAULT_CODEMODE_SOURCES,
    code: `async ({ ctx }) => {
  const ping = await ctx.example.ping({});
  const streams = await ctx.events.listStreams({});
  const resources = await ctx.semaphore.resources.list({});
  const routes = await ctx.ingressProxy.routes.list({ limit: 5, offset: 0 });

  return {
    ping,
    streamCount: streams.length,
    semaphoreResources: resources.length,
    ingressRoutes: routes.total,
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
    title: "Lease And Route",
    description: "Lease a tunnel from semaphore and build an ingress route from it.",
    sources: DEFAULT_CODEMODE_SOURCES,
    code: `async ({ ctx }) => {
  const lease = await ctx.semaphore.resources.acquire({
    type: "cloudflare-tunnel",
    leaseMs: 60_000,
    waitMs: 0,
  });

  const route = await ctx.ingressProxy.routes.upsert({
    rootHost: \`\${lease.slug}.demo.ingress.iterate.com\`,
    targetUrl: \`https://\${lease.slug}.internal.iterate.com\`,
    metadata: {
      source: "codemode",
      leaseSlug: lease.slug,
    },
  });

  return { lease, route };
};`,
  },
  {
    id: "inventory-cross-check",
    title: "Cross-Check Inventory",
    description: "Compare leased semaphore tunnel resources against ingress route metadata.",
    sources: DEFAULT_CODEMODE_SOURCES,
    code: `async ({ ctx }) => {
  const resources = await ctx.semaphore.resources.list({
    type: "cloudflare-tunnel",
  });
  const routes = await ctx.ingressProxy.routes.list({ limit: 100, offset: 0 });

  const leasedSlugs = new Set(
    resources
      .filter((resource) => resource.leaseState === "leased")
      .map((resource) => resource.slug),
  );

  return routes.routes.map((route) => ({
    rootHost: route.rootHost,
    targetUrl: route.targetUrl,
    leaseSlug:
      typeof route.metadata.leaseSlug === "string" ? route.metadata.leaseSlug : null,
    leaseState:
      typeof route.metadata.leaseSlug === "string" &&
      leasedSlugs.has(route.metadata.leaseSlug)
        ? "leased"
        : "not-leased",
  }));
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
