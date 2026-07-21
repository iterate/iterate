interface StreamStagingEnv {
  CF_VERSION_METADATA?: { id: string; tag?: string };
  STREAM: DurableObjectNamespace<import("./worker").StreamDurableObject>;
}

interface Env extends StreamStagingEnv {}

declare namespace Cloudflare {
  interface Env extends StreamStagingEnv {}
}
