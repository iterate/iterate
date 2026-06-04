interface StreamStagingEnv {
  STREAM: DurableObjectNamespace<import("./worker").Stream>;
  STREAM_PROCESSOR_RUNNER: DurableObjectNamespace<import("./worker").StreamProcessorRunner>;
}

interface Env extends StreamStagingEnv {}

declare namespace Cloudflare {
  interface Env extends StreamStagingEnv {}
}
