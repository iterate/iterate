interface StreamStagingEnv {
  STREAM: DurableObjectNamespace<import("./worker").StreamDurableObject>;
}

interface Env extends StreamStagingEnv {}

declare namespace Cloudflare {
  interface Env extends StreamStagingEnv {}
}
