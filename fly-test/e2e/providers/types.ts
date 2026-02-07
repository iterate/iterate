export type FetchPayload = {
  url: string;
  method?: string;
  body?: string;
};

export type ProviderInit = {
  flyDir: string;
  app: string;
  cleanupOnExit: boolean;
  targetUrl: string;
  log: (line: string) => void;
};

export interface ObservabilityProvider {
  readonly name: "docker" | "fly";
  up(): Promise<void>;
  sandboxFetch(payload: FetchPayload): Promise<string>;
  readSandboxLog(): Promise<string>;
  readEgressLog(): Promise<string>;
  down(): Promise<void>;
}
