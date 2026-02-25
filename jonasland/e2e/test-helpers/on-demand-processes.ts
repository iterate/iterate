export const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

export type OnDemandProcessConfig = {
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck?: {
    host: string;
    path: string;
    timeoutMs?: number;
    readyStatus?: "ok" | "lt400";
  };
  directHttpCheck?: {
    url: string;
    timeoutMs?: number;
  };
  startupTimeoutMs?: number;
};

export const sharedOnDemandProcesses = {
  orders: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/orders-service/src/server.ts"],
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
      },
    },
    routeCheck: { host: "orders.iterate.localhost", path: "/healthz" },
  },
  outerbase: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/outerbase-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "outerbase.iterate.localhost", path: "/healthz" },
  },
  docs: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/docs-service/src/server.ts"],
      env: OTEL_SERVICE_ENV,
    },
    routeCheck: { host: "docs.iterate.localhost", path: "/healthz" },
  },
} satisfies Record<string, OnDemandProcessConfig>;

type OnDemandProcessRuntime = {
  pidnap: {
    processes: {
      updateConfig(params: {
        processSlug: string;
        definition: OnDemandProcessConfig["definition"];
        options: { restartPolicy: "always" };
        envOptions: { reloadDelay: false };
      }): Promise<{ state: string }>;
      start(params: { target: string }): Promise<unknown>;
    };
  };
  waitForPidnapProcessRunning(params: { target: string; timeoutMs?: number }): Promise<void>;
};

export async function startOnDemandProcess(params: {
  deployment: OnDemandProcessRuntime;
  processName: string;
  processConfig: OnDemandProcessConfig;
  waitForHostRoute?: (params: NonNullable<OnDemandProcessConfig["routeCheck"]>) => Promise<void>;
  waitForDirectHttp?: (
    params: NonNullable<OnDemandProcessConfig["directHttpCheck"]>,
  ) => Promise<void>;
  defaultTimeoutMs?: number;
}): Promise<void> {
  const { deployment, processName, processConfig } = params;
  const timeoutMs = params.defaultTimeoutMs ?? 45_000;

  const updated = await deployment.pidnap.processes.updateConfig({
    processSlug: processName,
    definition: processConfig.definition,
    options: { restartPolicy: "always" },
    envOptions: { reloadDelay: false },
  });

  if (updated.state !== "running") {
    await deployment.pidnap.processes.start({ target: processName });
  }

  await deployment.waitForPidnapProcessRunning({
    target: processName,
    timeoutMs: processConfig.startupTimeoutMs ?? timeoutMs,
  });

  if (processConfig.routeCheck) {
    if (!params.waitForHostRoute) {
      throw new Error(`missing waitForHostRoute for process ${processName}`);
    }
    await params.waitForHostRoute({
      ...processConfig.routeCheck,
      timeoutMs: processConfig.routeCheck.timeoutMs ?? processConfig.startupTimeoutMs ?? timeoutMs,
    });
  }

  if (processConfig.directHttpCheck) {
    if (!params.waitForDirectHttp) {
      throw new Error(`missing waitForDirectHttp for process ${processName}`);
    }
    await params.waitForDirectHttp({
      ...processConfig.directHttpCheck,
      timeoutMs:
        processConfig.directHttpCheck.timeoutMs ?? processConfig.startupTimeoutMs ?? timeoutMs,
    });
  }
}

export type DocsSourcesPayload = {
  sources: Array<{ id: string; title: string; specUrl: string }>;
  total: number;
};

export async function waitForDocsSources(params: {
  expectedHosts: string[];
  fetchSources: () => Promise<DocsSourcesPayload | undefined>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<DocsSourcesPayload> {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const payload = await params.fetchSources();
    if (payload) {
      const ids = new Set(payload.sources.map((source) => source.id));
      const allPresent = params.expectedHosts.every((expectedHost) => ids.has(expectedHost));
      if (allPresent) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`timed out waiting for docs sources: ${params.expectedHosts.join(", ")}`);
}
