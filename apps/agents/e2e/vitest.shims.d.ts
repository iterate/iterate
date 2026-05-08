declare module "vitest" {
  export interface ProvidedContext {
    e2eRunRoot: string;
    e2eProjectRoot: string;
    e2eEventsBaseUrl: string;
    e2eRunSlug: string;
    e2eRepoRoot: string;
  }
}

export {};
