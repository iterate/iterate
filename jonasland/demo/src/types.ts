export type RuntimePhase = "idle" | "starting" | "running" | "stopping" | "error";

export type MockConfig = {
  openaiOutputText: string;
  openaiModel: string;
  slackResponseOk: boolean;
  slackResponseTs: string;
  defaultSlackPrompt: string;
};

export type RuntimeState = {
  phase: RuntimePhase;
  containerName: string | null;
  ingressUrl: string | null;
  image: string;
  externalEgressProxy: string;
  lastError: string | null;
  busy: boolean;
  mockConfig: MockConfig;
};

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
