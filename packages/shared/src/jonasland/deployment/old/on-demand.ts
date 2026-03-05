import pWaitFor from "p-wait-for";

const OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

const CONTAINER_REPO_ROOT = "/home/iterate/src/github.com/iterate/iterate";
const TSX_BIN_CANDIDATES = [
  "/opt/pidnap/node_modules/.bin/tsx",
  `${CONTAINER_REPO_ROOT}/packages/pidnap/node_modules/.bin/tsx`,
] as const;

const TSX_LAUNCH_SCRIPT = [
  ...TSX_BIN_CANDIDATES.map((tsxPath) => `if [ -x "${tsxPath}" ]; then exec "${tsxPath}" "$1"; fi`),
  `echo "tsx binary not found in expected paths: ${TSX_BIN_CANDIDATES.join(" ")}" >&2`,
  "exit 127",
].join("; ");

function createTsxDefinition(params: {
  scriptPath: string;
  env: Record<string, string>;
}): OnDemandProcessConfig["definition"] {
  return {
    command: "sh",
    args: ["-lc", TSX_LAUNCH_SCRIPT, "tsx-launcher", params.scriptPath],
    env: params.env,
  };
}

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

const sharedOnDemandProcesses = {
  orders: {
    definition: createTsxDefinition({
      scriptPath: `${CONTAINER_REPO_ROOT}/services/orders/src/server.ts`,
      env: {
        ...OTEL_SERVICE_ENV,
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010/orpc",
      },
    }),
    routeCheck: { host: "orders.iterate.localhost", path: "/__iterate/health" },
  },
  outerbase: {
    definition: createTsxDefinition({
      scriptPath: `${CONTAINER_REPO_ROOT}/services/outerbase-service/src/server.ts`,
      env: OTEL_SERVICE_ENV,
    }),
    routeCheck: { host: "outerbase.iterate.localhost", path: "/__iterate/health" },
  },
  docs: {
    definition: createTsxDefinition({
      scriptPath: `${CONTAINER_REPO_ROOT}/services/docs-service/src/server.ts`,
      env: OTEL_SERVICE_ENV,
    }),
    routeCheck: { host: "docs.iterate.localhost", path: "/__iterate/health" },
  },
} satisfies Record<string, OnDemandProcessConfig>;

export const onDemandProcesses = {
  ...sharedOnDemandProcesses,
  home: {
    definition: createTsxDefinition({
      scriptPath: `${CONTAINER_REPO_ROOT}/services/home-service/src/server.ts`,
      env: OTEL_SERVICE_ENV,
    }),
    routeCheck: { host: "home.iterate.localhost", path: "/" },
  },
  "egress-proxy": {
    definition: createTsxDefinition({
      scriptPath: `${CONTAINER_REPO_ROOT}/services/egress-service/src/server.ts`,
      env: OTEL_SERVICE_ENV,
    }),
    directHttpCheck: { url: "http://127.0.0.1:19000/__iterate/health" },
  },
  openobserve: {
    definition: {
      command: "/usr/local/bin/openobserve",
      args: [],
      env: {
        ZO_ROOT_USER_EMAIL: "root@example.com",
        ZO_ROOT_USER_PASSWORD: "Complexpass#123",
        ZO_LOCAL_MODE: "true",
        ZO_DATA_DIR: "/var/lib/openobserve",
      },
    },
    startupTimeoutMs: 120_000,
    routeCheck: {
      host: "openobserve.iterate.localhost",
      path: "/",
      timeoutMs: 120_000,
      readyStatus: "lt400",
    },
  },
  caddymanager: {
    definition: {
      command: "node",
      args: [`${CONTAINER_REPO_ROOT}/jonasland/sandbox/caddymanager/server.mjs`],
      env: {},
    },
    routeCheck: {
      host: "caddymanager.iterate.localhost",
      path: "/__iterate/health",
      timeoutMs: 60_000,
    },
  },
} satisfies Record<string, OnDemandProcessConfig>;

export type OnDemandProcessName = keyof typeof onDemandProcesses;

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
  processName: OnDemandProcessName;
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
  let result: DocsSourcesPayload | undefined;
  await pWaitFor(
    async () => {
      const payload = await params.fetchSources();
      if (!payload) return false;
      const ids = new Set(payload.sources.map((source) => source.id));
      if (params.expectedHosts.every((host) => ids.has(host))) {
        result = payload;
        return true;
      }
      return false;
    },
    {
      interval: params.pollIntervalMs ?? 300,
      timeout: {
        milliseconds: params.timeoutMs ?? 45_000,
        message: `timed out waiting for docs sources: ${params.expectedHosts.join(", ")}`,
      },
    },
  );
  return result!;
}
