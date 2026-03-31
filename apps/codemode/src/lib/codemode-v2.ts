export interface CodemodeExampleSnippet {
  id: string;
  title: string;
  description: string;
  code: string;
}

export const CODEMODE_EXAMPLES: CodemodeExampleSnippet[] = [
  {
    id: "service-overview",
    title: "Service Overview",
    description:
      "Ping example, count streams, inspect semaphore inventory, and list ingress routes.",
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
