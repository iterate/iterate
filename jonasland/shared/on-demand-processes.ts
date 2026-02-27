export type OnDemandProcessName =
  | "egress-proxy"
  | "opencode"
  | "agents"
  | "opencode-wrapper"
  | "pi-wrapper"
  | "slack"
  | "outerbase"
  | "clickstack";

export type OnDemandProcessConfig = {
  slug: OnDemandProcessName;
  definition: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  routeCheck?: {
    host: string;
    path: string;
    timeoutMs?: number;
  };
  directHttpCheck?: {
    url: string;
    timeoutMs?: number;
  };
};

export const ON_DEMAND_OTEL_SERVICE_ENV = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:15318",
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:15318/v1/traces",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:15318/v1/logs",
  OTEL_PROPAGATORS: "tracecontext,baggage",
};

type OnDemandProcessMap = Record<OnDemandProcessName, Omit<OnDemandProcessConfig, "slug">>;

export const ON_DEMAND_PROCESSES_BY_NAME: OnDemandProcessMap = {
  "egress-proxy": {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/egress-service/src/server.ts"],
      env: ON_DEMAND_OTEL_SERVICE_ENV,
    },
    directHttpCheck: { url: "http://127.0.0.1:19000/healthz" },
  },
  opencode: {
    definition: {
      command: "/root/.opencode/bin/opencode",
      args: [
        "serve",
        "--port",
        "4096",
        "--hostname",
        "0.0.0.0",
        "--log-level",
        "DEBUG",
        "--print-logs",
      ],
      env: {
        ...ON_DEMAND_OTEL_SERVICE_ENV,
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: "test-key",
      },
    },
    directHttpCheck: { url: "http://127.0.0.1:4096/healthz" },
  },
  agents: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/agents/src/server.ts"],
      env: {
        ...ON_DEMAND_OTEL_SERVICE_ENV,
        AGENTS_SERVICE_PORT: "19061",
        OPENCODE_WRAPPER_BASE_URL: "http://127.0.0.1:19062",
        PI_WRAPPER_BASE_URL: "http://127.0.0.1:19064",
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010",
        AGENTS_SERVICE_DB_PATH: "/var/lib/jonasland/agents-service.sqlite",
      },
    },
    routeCheck: { host: "agents.iterate.localhost", path: "/healthz" },
  },
  "opencode-wrapper": {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/opencode-wrapper/src/server.ts"],
      env: {
        ...ON_DEMAND_OTEL_SERVICE_ENV,
        OPENCODE_WRAPPER_SERVICE_PORT: "19062",
        OPENCODE_BASE_URL: "http://127.0.0.1:4096",
        OPENAI_BASE_URL: "http://api.openai.com",
        SLACK_API_BASE_URL: "http://slack.com",
        OPENAI_MODEL: "gpt-4o-mini",
        OPENCODE_PROVIDER_ID: "openai",
        OPENCODE_MODEL_ID: "gpt-4o-mini",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
        DAEMON_SERVICE_BASE_URL: "http://127.0.0.1:19060",
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010",
      },
    },
    routeCheck: { host: "opencode-wrapper.iterate.localhost", path: "/healthz" },
  },
  "pi-wrapper": {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/pi-wrapper/src/server.ts"],
      env: {
        ...ON_DEMAND_OTEL_SERVICE_ENV,
        PI_WRAPPER_SERVICE_PORT: "19064",
        PI_MODEL_PROVIDER: "openai",
        PI_MODEL_ID: "gpt-4o-mini",
        PI_AGENT_DIR: "/var/lib/jonasland/pi-agent",
        PI_WORKING_DIRECTORY: "/tmp",
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: "test-key",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010",
      },
    },
    routeCheck: { host: "pi-wrapper.iterate.localhost", path: "/healthz" },
  },
  slack: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/slack/src/server.ts"],
      env: {
        ...ON_DEMAND_OTEL_SERVICE_ENV,
        SLACK_SERVICE_PORT: "19063",
        SLACK_SERVICE_DB_PATH: "/var/lib/jonasland/slack-service.sqlite",
        AGENTS_SERVICE_BASE_URL: "http://127.0.0.1:19061",
        EVENTS_SERVICE_BASE_URL: "http://127.0.0.1:19010",
        SLACK_API_BASE_URL: "http://slack.com",
        SLACK_AGENT_PROVIDER: "opencode",
      },
    },
    routeCheck: { host: "slack.iterate.localhost", path: "/healthz" },
  },
  outerbase: {
    definition: {
      command: "/opt/pidnap/node_modules/.bin/tsx",
      args: ["/opt/services/outerbase-service/src/server.ts"],
      env: ON_DEMAND_OTEL_SERVICE_ENV,
    },
    routeCheck: {
      host: "outerbase.iterate.localhost",
      path: "/healthz",
      timeoutMs: 60_000,
    },
  },
  clickstack: {
    definition: {
      command: "/opt/jonasland-sandbox/clickstack-launcher.sh",
      args: [],
      env: {},
    },
    routeCheck: {
      host: "clickstack.iterate.localhost",
      path: "/",
      timeoutMs: 120_000,
    },
  },
};

const ON_DEMAND_PROCESS_NAMES = Object.keys(ON_DEMAND_PROCESSES_BY_NAME) as OnDemandProcessName[];

export const ON_DEMAND_PROCESSES: OnDemandProcessConfig[] = ON_DEMAND_PROCESS_NAMES.map((name) => ({
  slug: name,
  ...ON_DEMAND_PROCESSES_BY_NAME[name],
}));
