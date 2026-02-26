export type DemoEvent = {
  id: string;
  createdAt: string;
  message: string;
};

export type EgressRecord = {
  id: string;
  method: string;
  path: string;
  host: string;
  headers: Record<string, string | string[]>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  createdAt: string;
  durationMs: number;
};

export type JonaslandDemoProvider = "docker" | "fly";
export type JonaslandRuntimePhase = "idle" | "starting" | "running" | "stopping" | "error";
export type JonaslandEgressFallbackMode = "deny-all" | "proxy-internet";

export type JonaslandMockRule = {
  id: string;
  name: string;
  enabled: boolean;
  method: string;
  hostPattern: string;
  pathPattern: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
};

export type JonaslandDemoConfig = {
  defaultSlackPrompt: string;
  fallbackMode: JonaslandEgressFallbackMode;
  mockRules: JonaslandMockRule[];
};

export type JonaslandDemoLinks = {
  home: string | null;
};

export type JonaslandSandbox = {
  image: string;
  containerName: string | null;
  ingressUrl: string | null;
  externalEgressProxy: string;
};

export type JonaslandDemoState = {
  provider: JonaslandDemoProvider;
  phase: JonaslandRuntimePhase;
  busy: boolean;
  lastError: string | null;
  sandbox: JonaslandSandbox;
  links: JonaslandDemoLinks;
  config: JonaslandDemoConfig;
  records: EgressRecord[];
  events: DemoEvent[];
};

export type SimulateSlackInput = {
  text?: string;
  channel?: string;
  threadTs?: string;
};

export type SimulateSlackResult = {
  status: number;
  ok: boolean;
  body: string;
  threadTs: string;
  channel: string;
  text: string;
};
