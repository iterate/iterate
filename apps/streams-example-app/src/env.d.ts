interface StreamStagingEnv {
  DEPLOYMENT_ENV?: string;
  PREVIEW_TEST_RETIREMENT?: string;
  PROJECT_DIRECTORY: KVNamespace;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  STREAM: DurableObjectNamespace<import("./worker").StreamDurableObject>;
}

interface Env extends StreamStagingEnv {}

declare namespace Cloudflare {
  interface Env extends StreamStagingEnv {}
}
